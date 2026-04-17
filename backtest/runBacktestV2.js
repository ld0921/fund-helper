// V2 回测引擎：从 SQLite 读日净值，按月滚动，全链路回测
// 与 V1 对比：
//   V1（方案 A）：只用类别月度收益做资产配置层回测
//   V2（方案 B）：单基金日净值 → 按月重算 r1/r3/maxDD → scoreF 选基 → selectFunds → computeWeights → 月度 rebalance
//
// 简化假设（写进 findings-v3 的局限性）：
//   - mgrYears/size/fee：用 data/history-pool.json 当时值（2026-04 时点），不模拟历史变化
//   - risk 字段：按类别默认（active/index/qdii → R4, bond → R2, money → R1）
//   - INDEX_VALUATION：方案 B 不模拟历史 PE 百分位（valuationAdj=0）
//   - 幸存者偏差：用 Top 340 池，但每月按"基金是否在 t 时有 ≥3 年历史"过滤
//   - 持仓跟踪简化：用类别级权重 × 类别平均月收益，不逐基金跟踪（待 2.2.C 扩展为完整选基）
//
// 用法:
//   node backtest/runBacktestV2.js
//   node backtest/runBacktestV2.js --profile=balanced --horizon=5

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createShim } = require('./envShim');

const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');
const POOL_PATH = path.resolve(__dirname, '../data/history-pool.json');

const DEFAULT_RISK = { active: 'R4', index: 'R4', bond: 'R2', qdii: 'R4', money: 'R1' };
const DEFAULT_FEE = { active: 0.15, index: 0.12, bond: 0.08, qdii: 0.15, money: 0 };
const DEFAULT_MGR = 3;       // 经理任期，简化为常数 3 年
const DEFAULT_SIZE = 20;     // 基金规模，简化为常数 20 亿

// 回测起止：data 覆盖 2021-04-18 ~ 2026-04-15
// 前 36 个月（2021-04 ~ 2024-04）作为初始化窗口，用于计算 r3/maxDD3y
// 有效回测期：2024-04-30 ~ 2026-03-31 （24 个月，和方案 A 对齐以便对比）
// 如需更长周期：改 START_TIME 和 END_TIME
const START_DATE = '2024-04-30';
const END_DATE   = '2026-03-31';

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ 先运行 scripts/fetch-history-nav.js + scripts/import-nav-to-sqlite.js');
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));

  // 1. 预读所有基金净值到内存（便于按时点查询）
  console.log('═══ V2 回测引擎 ═══\n[1/5] 加载基金数据到内存...');
  const fundsMeta = db.prepare('SELECT code, name, cat, first_date, last_date, point_count FROM funds').all();
  const fundNavs = {}; // { code: [{ts, nav}, ...] }
  const stmt = db.prepare('SELECT ts, nav FROM nav_daily WHERE code = ? ORDER BY ts ASC');
  fundsMeta.forEach(f => {
    fundNavs[f.code] = stmt.all(f.code);
  });
  console.log(`  加载 ${fundsMeta.length} 只基金 · ${Object.values(fundNavs).reduce((s, a) => s + a.length, 0)} 数据点`);

  // 把 pool 元数据合并进来
  const poolMap = {};
  pool.funds.forEach(f => { poolMap[f.code] = f; });

  // 2. 生成月末时间戳序列
  console.log('\n[2/5] 生成月末时间序列...');
  const monthEnds = generateMonthEnds(START_DATE, END_DATE);
  console.log(`  ${monthEnds.length} 个月末：${new Date(monthEnds[0]).toISOString().slice(0, 10)} ~ ${new Date(monthEnds[monthEnds.length - 1]).toISOString().slice(0, 10)}`);

  // 3. 准备 shim（加载 market.js + portfolio.js）
  console.log('\n[3/5] 初始化回测 shim（加载生产算法代码）...');
  const shim = createShim();

  // 4. 按月循环
  console.log('\n[4/5] 执行月度 rebalance...');
  const profiles = [
    { name: '平衡+1年', riskProfile: 'balanced', horizon: 1 },
    { name: '平衡+2年', riskProfile: 'balanced', horizon: 2 },
    { name: '平衡+3年', riskProfile: 'balanced', horizon: 3 },
    { name: '进取+1年', riskProfile: 'aggressive', horizon: 1 },
    { name: '进取+2年', riskProfile: 'aggressive', horizon: 2 },
    { name: '进取+3年', riskProfile: 'aggressive', horizon: 3 },
    { name: '进取+5年', riskProfile: 'aggressive', horizon: 5 },
  ];
  const baselines = [
    { name: '基线：等权 25%×4', fixedWeights: { active: 25, index: 25, bond: 25, qdii: 25, money: 0 } },
    { name: '基线：60/40 股债', fixedWeights: { active: 30, index: 30, bond: 40, qdii: 0, money: 0 } },
  ];

  const results = {};
  [...profiles, ...baselines].forEach(p => {
    results[p.name] = { profile: p, monthlyReturns: [], phases: [], weightHistory: [] };
  });

  for (let i = 0; i < monthEnds.length - 1; i++) {
    const t = monthEnds[i];
    const tNext = monthEnds[i + 1];
    const tDateStr = new Date(t).toISOString().slice(0, 10);

    // (a) 每基金按 t 时点重算 r1/r3/maxDD3y
    const fundsAtT = [];
    for (const meta of fundsMeta) {
      const navs = fundNavs[meta.code];
      const stats = computeStatsAtT(navs, t);
      if (!stats) continue; // 数据不足（< 3 年）
      const poolInfo = poolMap[meta.code] || {};
      fundsAtT.push({
        code: meta.code,
        name: meta.name,
        cat: meta.cat,
        risk: DEFAULT_RISK[meta.cat] || 'R4',
        r1: stats.r1,
        r3: stats.r3,
        maxDD: stats.maxDD,
        maxDD3y: stats.maxDD3y,
        mgr: DEFAULT_MGR,
        mgrYears: DEFAULT_MGR,
        size: poolInfo.size || DEFAULT_SIZE,
        fee: poolInfo.fee !== undefined ? poolInfo.fee : DEFAULT_FEE[meta.cat],
        monthlyReturns: stats.monthlyReturns,
        composite: 0, // 待后续算
      });
    }

    // (b) 构建 MARKET_BENCHMARKS（按类别汇总）
    const mb = buildMarketBenchmarks(fundsAtT);
    shim.setBenchmarks(mb);
    // _catBench 是 score.js 读的全局，需要同步注入
    const catBench = {};
    Object.keys(mb).forEach(c => {
      if (mb[c] && typeof mb[c] === 'object' && mb[c].avgR1 !== undefined) {
        catBench[c] = { avgR1: mb[c].avgR1, avgR3: mb[c].avgR3, avgDD: mb[c].avgDD, stdR1: mb[c].stdR1, count: mb[c].count };
      }
    });
    shim.sandbox._catBench = catBench;

    // (c) 构建 catRanks（方案 A 兼容格式）
    const catRanks = buildCatRanks(fundsAtT, mb);

    // (d) 运行 inferMomentumPhase
    const phase = shim.inferMomentumPhase(catRanks);

    // 对每个画像/基线跑 computeWeights
    for (const p of [...profiles, ...baselines]) {
      let weights;
      if (p.fixedWeights) {
        weights = p.fixedWeights;
      } else {
        weights = shim.computeWeights(p.riskProfile, p.horizon, catRanks, phase);
      }

      // (e) 组合月收益 = Σ weight × 该类别在 [t, tNext] 的月收益均值
      //     V2 初版：类别层月收益（用该类别所有基金 [t, tNext] 的平均）
      //     下一迭代：接入 selectFunds 逐基金回测
      const ret = computeCategoryMonthReturn(weights, fundsAtT, fundNavs, t, tNext);
      results[p.name].monthlyReturns.push(ret);
      results[p.name].phases.push(phase.phase);
      results[p.name].weightHistory.push({ t: tDateStr, weights, phase: phase.phase });
    }

    if (i % 3 === 0 || i === monthEnds.length - 2) {
      console.log(`  [${i + 1}/${monthEnds.length - 1}] ${tDateStr} · phase=${phase.phase} · 基金池=${fundsAtT.length}`);
    }
  }

  // 5. 输出
  console.log('\n[5/5] 写入结果...');
  // 从 fundsMeta + fundNavs 构造类别月度收益序列（供 metrics.js 计算 phase 命中率）
  const catSeqs = buildCategoryMonthlyReturns(fundsMeta, fundNavs, monthEnds);
  const out = {
    generatedAt: new Date().toISOString(),
    version: 'V2',
    startDate: START_DATE,
    endDate: END_DATE,
    monthCount: monthEnds.length - 1,
    fundsLoaded: fundsMeta.length,
    seqs: catSeqs, // 供 phase 命中率计算
    results: Object.entries(results).map(([name, r]) => ({
      name,
      profile: r.profile,
      monthlyReturns: r.monthlyReturns,
      phases: r.phases,
      weightHistory: r.weightHistory,
    })),
  };
  const outPath = path.resolve(__dirname, 'results-v2.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`  写入 ${path.relative(path.resolve(__dirname, '..'), outPath)}`);

  // 简单汇总
  console.log('\n═══ 快速预览 ═══');
  console.log('| 画像/基线 | 月数 | 简单累计% |');
  console.log('|---|---|---|');
  Object.entries(results).forEach(([name, r]) => {
    const sum = r.monthlyReturns.reduce((s, v) => s + v, 0);
    console.log(`| ${name} | ${r.monthlyReturns.length} | ${sum.toFixed(2)} |`);
  });

  db.close();
}

// 生成从 startDate 到 endDate 的月末时间戳（当月最后一个交易日简化为月末）
function generateMonthEnds(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const result = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    // 本月最后一天
    const lastDay = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    if (lastDay >= start && lastDay <= end) {
      result.push(lastDay.getTime());
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  return result;
}

// 在 t 时点用历史数据重算基金指标
function computeStatsAtT(navs, t) {
  // navs: 升序的 {ts, nav}
  const navsBeforeT = navs.filter(p => p.ts <= t);
  if (navsBeforeT.length < 24) return null; // 数据不足

  const navAtT = navsBeforeT[navsBeforeT.length - 1];
  const oneYearAgo = t - 365.25 * 24 * 60 * 60 * 1000;
  const threeYearsAgo = t - 3 * 365.25 * 24 * 60 * 60 * 1000;

  // 近 1 年数据
  const navs1y = navsBeforeT.filter(p => p.ts >= oneYearAgo);
  if (navs1y.length < 10) return null;
  const r1 = (navAtT.nav / navs1y[0].nav - 1) * 100;

  // 近 3 年数据
  const navs3y = navsBeforeT.filter(p => p.ts >= threeYearsAgo);
  if (navs3y.length < 30) return null;
  const r3 = (navAtT.nav / navs3y[0].nav - 1) * 100;

  // 近 3 年最大回撤
  let peak = 0, maxDD3y = 0;
  navs3y.forEach(p => {
    if (p.nav > peak) peak = p.nav;
    if (peak > 0) {
      const dd = (peak - p.nav) / peak * 100;
      if (dd > maxDD3y) maxDD3y = dd;
    }
  });

  // 全期最大回撤（简化为近 3 年）
  const maxDD = maxDD3y;

  // 月度收益序列（近 3 年）
  const byMonth = {};
  navs3y.forEach(p => {
    const d = new Date(p.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`;
    byMonth[key] = p.nav;
  });
  const monthlyKeys = Object.keys(byMonth).sort();
  const monthlyReturns = [];
  for (let i = 1; i < monthlyKeys.length; i++) {
    const prev = byMonth[monthlyKeys[i - 1]], cur = byMonth[monthlyKeys[i]];
    if (prev > 0) monthlyReturns.push((cur / prev - 1) * 100);
  }

  return { r1, r3, maxDD, maxDD3y, monthlyReturns };
}

// 构建 MARKET_BENCHMARKS：按类别对 r1/r3/maxDD 做平均，构造 monthlyReturns 序列
function buildMarketBenchmarks(funds) {
  const cats = ['active', 'index', 'bond', 'qdii', 'money'];
  const mb = {};
  cats.forEach(cat => {
    const list = funds.filter(f => f.cat === cat);
    if (list.length === 0) {
      // 无基金的类别给出默认值（货币基金可能在本池缺失）
      mb[cat] = null;
      return;
    }
    const avgR1 = list.reduce((s, f) => s + f.r1, 0) / list.length;
    const avgR3 = list.reduce((s, f) => s + f.r3, 0) / list.length;
    const avgDD = list.reduce((s, f) => s + f.maxDD, 0) / list.length;
    const stdR1 = Math.sqrt(list.reduce((s, f) => s + (f.r1 - avgR1) ** 2, 0) / list.length) || 1;
    // 月度收益序列：取各基金序列的逐月均值（和生产代码一致）
    const allMonthly = list.map(f => f.monthlyReturns).filter(a => a && a.length >= 6);
    let monthlyReturns = [];
    if (allMonthly.length > 0) {
      const minLen = Math.min(...allMonthly.map(a => a.length));
      for (let i = 0; i < minLen; i++) {
        const avg = allMonthly.reduce((s, a) => s + a[i], 0) / allMonthly.length;
        monthlyReturns.push(avg);
      }
    }
    mb[cat] = {
      avgR1, avgR3, stdR1, avgDD,
      count: list.length,
      monthlyReturns,
    };
  });
  // 如果 money 缺失，用 bond 的 20% 作为近似
  if (!mb.money) {
    mb.money = {
      avgR1: 2, avgR3: 6, stdR1: 0.1, avgDD: 0, count: 0,
      monthlyReturns: Array(36).fill(0.15),
    };
  }
  mb._bondYield = 2.0; // 常数近似，后续可加历史国债数据
  return mb;
}

function buildCatRanks(funds, mb) {
  const cats = ['active', 'index', 'bond', 'qdii', 'money'];
  return cats.map(cat => {
    const b = mb[cat];
    if (!b) return null;
    const r3Ann = b.avgR3 > -100 ? (Math.pow(1 + b.avgR3 / 100, 1 / 3) - 1) * 100 : 0;
    const catScore = b.avgDD > 0 ? r3Ann / b.avgDD * 10 : r3Ann;
    return {
      cat, name: cat,
      avgR1: b.avgR1, avgR3: b.avgR3, stdR1: b.stdR1, avgDD: b.avgDD,
      avgChg: 0,
      catScore,
      catTrend: b.avgR1 > 0 ? 2 : -2,
      avgCalmar: b.avgDD > 0 ? r3Ann / b.avgDD : 0,
      topFunds: funds.filter(f => f.cat === cat),
    };
  }).filter(Boolean).sort((a, b) => b.catScore - a.catScore);
}

// V2 初版：组合月收益 = 各类别权重 × 该类别 [t, tNext] 平均收益
// 这等价于"完美等权持有该类别所有基金"
function computeCategoryMonthReturn(weights, funds, fundNavs, t, tNext) {
  let ret = 0;
  const cats = ['active', 'index', 'bond', 'qdii', 'money'];
  for (const cat of cats) {
    const w = (weights[cat] || 0) / 100;
    if (w === 0) continue;
    const list = funds.filter(f => f.cat === cat);
    if (list.length === 0) continue;

    // 每只基金在 [t, tNext] 的收益率，取均值
    const catRets = [];
    for (const f of list) {
      const navs = fundNavs[f.code];
      const navAtT = findLastNavBefore(navs, t);
      const navAtTNext = findLastNavBefore(navs, tNext);
      if (navAtT && navAtTNext && navAtT.nav > 0) {
        catRets.push((navAtTNext.nav / navAtT.nav - 1) * 100);
      }
    }
    if (catRets.length > 0) {
      const avg = catRets.reduce((s, v) => s + v, 0) / catRets.length;
      ret += w * avg;
    }
  }
  return ret;
}

function findLastNavBefore(navs, ts) {
  // 二分查找：返回 ts 之前（含）最后一个点
  let lo = 0, hi = navs.length - 1, best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (navs[mid].ts <= ts) { best = navs[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

// 构建每个类别在各月末的月度收益序列（用于 metrics.js phase 命中率）
function buildCategoryMonthlyReturns(fundsMeta, fundNavs, monthEnds) {
  const cats = ['active', 'index', 'bond', 'qdii', 'money'];
  const seqs = {};
  cats.forEach(cat => {
    const catFunds = fundsMeta.filter(f => f.cat === cat);
    const rets = [];
    for (let i = 0; i < monthEnds.length - 1; i++) {
      const t = monthEnds[i], tNext = monthEnds[i + 1];
      const monthRets = [];
      catFunds.forEach(f => {
        const navs = fundNavs[f.code];
        const a = findLastNavBefore(navs, t);
        const b = findLastNavBefore(navs, tNext);
        if (a && b && a.nav > 0) monthRets.push((b.nav / a.nav - 1) * 100);
      });
      if (monthRets.length > 0) {
        rets.push(monthRets.reduce((s, v) => s + v, 0) / monthRets.length);
      } else {
        rets.push(0);
      }
    }
    seqs[cat] = rets;
  });
  return seqs;
}

if (require.main === module) main();

module.exports = { computeStatsAtT, buildMarketBenchmarks, buildCatRanks };
