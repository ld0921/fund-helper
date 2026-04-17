// V2 回测引擎：从 SQLite 读日净值，按月滚动，全链路回测
// 与 V1 对比：
//   V1（方案 A）：只用类别月度收益做资产配置层回测
//   V2（方案 B）：单基金日净值 → 按月重算 r1/r3/maxDD → scoreF 选基 → selectFunds → computeWeights → 月度 rebalance
//
// 2.2.C 扩展：接入 selectFunds 选基层
//   两种模式：
//     --mode=category  类别均值（每个类别用全部基金的平均月收益）
//     --mode=select    真实选基（selectFunds 选出 1-3 只后按 pct 分配）
//     --mode=both      同时跑两种，便于对比（默认）
//
// 简化假设（写进 findings-v3 的局限性）：
//   - mgrYears/size/fee：用 data/history-pool.json 当时值（2026-04 时点），不模拟历史变化
//   - risk 字段：按类别默认（active/index/qdii → R4, bond → R2, money → R1）
//   - INDEX_VALUATION：方案 B 不模拟历史 PE 百分位（valuationAdj=0）
//   - 幸存者偏差：用 Top 340 池，但每月按"基金是否在 t 时有 ≥3 年历史"过滤
//   - manager/tags 无数据：selectFunds 的经理/标签去重降级
//
// 用法:
//   node backtest/runBacktestV2.js
//   node backtest/runBacktestV2.js --mode=select

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

const modeArg = process.argv.find(a => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.split('=')[1] : 'both'; // category | select | both
const NO_COSTS = process.argv.includes('--no-costs');

// 调仓频率：monthly（每月）| quarterly（每季度）| semi-annual（每半年）
const rebalArg = process.argv.find(a => a.startsWith('--rebalance='));
const REBALANCE_FREQ = rebalArg ? rebalArg.split('=')[1] : 'monthly';

// 交易成本参数（和生产 calculateRebalanceCost 对齐）
const PURCHASE_FEE_BY_CAT = { active: 0.0015, index: 0.0012, bond: 0.0008, qdii: 0.0008, money: 0 };
function redemptionFeeRate(holdDays) {
  if (holdDays < 7) return 0.015;
  if (holdDays < 365) return 0.005;
  if (holdDays < 730) return 0.0025;
  return 0;
}
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
  const initResult = (name, profile) => {
    results[name] = { profile, monthlyReturns: [], phases: [], weightHistory: [], costs: [], holdings: {} };
  };

  // 在 both 模式下，每个用户画像跑两组：类别均值版 + 选基版
  const profileVariants = [];
  for (const p of profiles) {
    if (MODE === 'category' || MODE === 'both') {
      profileVariants.push({ ...p, name: `${p.name} [类别均值]`, useSelect: false, applyCosts: false });
    }
    if (MODE === 'select' || MODE === 'both') {
      // 不含成本版（用于对比）
      profileVariants.push({ ...p, name: `${p.name} [智能选基-无成本]`, useSelect: true, applyCosts: false });
      // 含成本版（真实体验）
      if (!NO_COSTS) {
        profileVariants.push({ ...p, name: `${p.name} [智能选基+成本]`, useSelect: true, applyCosts: true });
      }
    }
  }
  // 基线不用选基、不计交易成本（fixed weights, no rebalance）
  for (const b of baselines) {
    profileVariants.push({ ...b, name: b.name, useSelect: false, applyCosts: false });
  }

  profileVariants.forEach(p => initResult(p.name, p));

  // 调仓频率控制：REBAL_EVERY 个月做一次新决策，中间月份保持上次持仓
  const REBAL_EVERY = { monthly: 1, quarterly: 3, 'semi-annual': 6 }[REBALANCE_FREQ] || 1;
  const lastPicksByProfile = {};   // { profileName: picks[] }
  const lastWeightsByProfile = {}; // { profileName: weights }
  console.log(`  调仓频率: ${REBALANCE_FREQ}（每 ${REBAL_EVERY} 月一次）`);

  for (let i = 0; i < monthEnds.length - 1; i++) {
    const t = monthEnds[i];
    const tNext = monthEnds[i + 1];
    const tDateStr = new Date(t).toISOString().slice(0, 10);
    const isRebalMonth = (i % REBAL_EVERY === 0);

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
        manager: meta.code, // 无真实经理数据，用 code 当唯一 id（selectFunds 经理去重会降级为只选 1 只/基金）
        tags: [],          // 无标签，selectFunds 会自动跳过标签去重
        size: poolInfo.size || DEFAULT_SIZE,
        fee: poolInfo.fee !== undefined ? poolInfo.fee : DEFAULT_FEE[meta.cat],
        monthlyReturns: stats.monthlyReturns,
        composite: 0, // 下一步计算
      });
    }

    // (b) 构建 MARKET_BENCHMARKS（按类别汇总）
    const mb = buildMarketBenchmarks(fundsAtT);
    shim.setBenchmarks(mb);
    const catBench = {};
    Object.keys(mb).forEach(c => {
      if (mb[c] && typeof mb[c] === 'object' && mb[c].avgR1 !== undefined) {
        catBench[c] = { avgR1: mb[c].avgR1, avgR3: mb[c].avgR3, avgDD: mb[c].avgDD, stdR1: mb[c].stdR1, count: mb[c].count };
      }
    });
    shim.sandbox._catBench = catBench;
    shim.setCuratedFunds(fundsAtT);

    // (c) 计算每个基金的 composite（模拟 analyzeCategoryPerf 的算法）
    fundsAtT.forEach(f => {
      f.composite = computeComposite(f, catBench[f.cat]);
    });

    // (d) 构建 catRanks
    const catRanks = buildCatRanks(fundsAtT, mb);

    // (e) 运行 inferMomentumPhase
    const phase = shim.inferMomentumPhase(catRanks);

    // 对每个 profile variant 跑 computeWeights + 可选的 selectFunds
    for (const p of profileVariants) {
      let weights;
      let picks = null;

      if (isRebalMonth) {
        // 调仓月：计算新的 weights + picks
        if (p.fixedWeights) {
          weights = p.fixedWeights;
        } else {
          weights = shim.computeWeights(p.riskProfile, p.horizon, catRanks, phase);
        }
        lastWeightsByProfile[p.name] = weights;

        if (p.useSelect) {
          picks = runSelectForAllCats(shim, catRanks, weights, p.riskProfile);
          lastPicksByProfile[p.name] = picks;
        }
      } else {
        // 非调仓月：沿用上次 weights + picks
        weights = lastWeightsByProfile[p.name] || p.fixedWeights;
        if (p.useSelect) {
          picks = lastPicksByProfile[p.name];
        }
      }

      let ret;
      let cost = 0;
      if (p.useSelect && picks) {
        ret = computePickedMonthReturn(picks, fundNavs, t, tNext);
        // 仅调仓月产生交易成本
        if (isRebalMonth && p.applyCosts) {
          cost = applyRebalanceCosts(results[p.name].holdings, picks, t, fundsAtT);
        } else if (isRebalMonth) {
          // 无成本但也要维护 holdings（首次持仓或换基）
          updateHoldingsNoCosts(results[p.name].holdings, picks, t);
        }
      } else {
        // 类别均值模式：每类别所有基金等权
        ret = computeCategoryMonthReturn(weights, fundsAtT, fundNavs, t, tNext);
      }
      // 扣除交易成本（cost 是 fraction，ret 是 %）
      const netRet = ret - cost * 100;
      results[p.name].monthlyReturns.push(netRet);
      results[p.name].phases.push(phase.phase);
      results[p.name].costs.push(cost * 100); // 成本也按 % 存，便于分析
      results[p.name].weightHistory.push({ t: tDateStr, weights, phase: phase.phase, rebal: isRebalMonth });
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
  console.log('| 画像/基线 | 月数 | 简单累计% | 成本累计% |');
  console.log('|---|---|---|---|');
  Object.entries(results).forEach(([name, r]) => {
    const sum = r.monthlyReturns.reduce((s, v) => s + v, 0);
    const costSum = (r.costs || []).reduce((s, v) => s + v, 0);
    console.log(`| ${name} | ${r.monthlyReturns.length} | ${sum.toFixed(2)} | ${costSum.toFixed(2)} |`);
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

// 计算基金的 composite 分数（模拟 market.js 的 analyzeCategoryPerf 内部逻辑）
// 和生产保持一致：calmar 50% + trendConsistency 25% + stability 20% + todayChg 5%(回测无 todayChg 所以是 0)
function computeComposite(f, bench) {
  const dd3y = f.maxDD3y || f.maxDD || 1;
  const r3Ann = f.r3 > -100 ? (Math.pow(1 + f.r3 / 100, 1 / 3) - 1) * 100 : 0;
  const alpha1 = bench ? f.r1 - bench.avgR1 : f.r1 - 1.7;
  const alpha3 = bench && bench.avgR3 ? r3Ann - (Math.pow(1 + bench.avgR3 / 100, 1 / 3) - 1) * 100 : r3Ann - 1.7;
  const calmarShort = dd3y > 0 ? alpha1 / dd3y : 0;
  const calmarLong = f.maxDD > 0 ? alpha3 / f.maxDD : 0;
  const calmar = calmarShort * 0.6 + calmarLong * 0.4;
  const trendScore = 0 * 0.2 + f.r1 * 0.5 + r3Ann * 0.3; // todayChg=0
  const trendConsistency = trendScore > 2 ? 3 : trendScore > 0.5 ? 2 : trendScore > 0 ? 1 : trendScore > -0.5 ? -1 : trendScore > -2 ? -2 : -3;
  const stability = Math.min(f.mgrYears, 15) / 15 * 10;
  return calmar * 10 * 0.5 + trendConsistency * 4 * 0.25 + stability * 0.20;
}

// 对所有类别调 selectFunds，返回所有 picks 的合集
function runSelectForAllCats(shim, catRanks, weights, riskProfile) {
  const allPicks = [];
  const cats = ['active', 'index', 'bond', 'qdii', 'money'];
  for (const cat of cats) {
    const w = weights[cat] || 0;
    if (w === 0) continue;
    const catData = catRanks.find(c => c.cat === cat);
    if (!catData || !catData.topFunds || catData.topFunds.length === 0) continue;
    try {
      const picks = shim.selectFunds(cat, catData, riskProfile, w, 10000);
      allPicks.push(...picks);
    } catch (e) {
      console.warn(`  ⚠️ selectFunds 失败 cat=${cat}: ${e.message}`);
    }
  }
  return allPicks;
}

// 基于 picks (每个带 pct) 计算组合 [t, tNext] 月收益
function computePickedMonthReturn(picks, fundNavs, t, tNext) {
  let ret = 0;
  for (const p of picks) {
    const navs = fundNavs[p.code];
    if (!navs) continue;
    const a = findLastNavBefore(navs, t);
    const b = findLastNavBefore(navs, tNext);
    if (a && b && a.nav > 0) {
      const fundRet = (b.nav / a.nav - 1) * 100;
      ret += (p.pct / 100) * fundRet;
    }
  }
  return ret;
}

// 交易成本：比较上月 holdings 和本月 picks，按 delta 扣费
// 返回本月总成本（fraction，如 0.003 = 0.3%）
// holdings: { code: { pct, avgBuyTs, cat } } - 传入对象会被修改
// picks: [{ code, pct, cat }]
// t: 当前月末时间戳
// fundsAtT: 用于获取 cat 信息
function applyRebalanceCosts(holdings, picks, t, fundsAtT) {
  const catByCode = {};
  fundsAtT.forEach(f => { catByCode[f.code] = f.cat; });
  picks.forEach(p => { if (!catByCode[p.code]) catByCode[p.code] = p.cat; });

  const newPctByCode = {};
  picks.forEach(p => { newPctByCode[p.code] = (newPctByCode[p.code] || 0) + p.pct; });

  const allCodes = new Set([...Object.keys(holdings), ...Object.keys(newPctByCode)]);
  let totalCost = 0;

  for (const code of allCodes) {
    const oldPct = holdings[code] ? holdings[code].pct : 0;
    const newPct = newPctByCode[code] || 0;
    const delta = newPct - oldPct;
    const cat = catByCode[code] || 'active';

    if (delta > 0.1) {
      // 买入（含新增和加仓）
      const purchaseRate = PURCHASE_FEE_BY_CAT[cat] || 0.0015;
      totalCost += (delta / 100) * purchaseRate;
      // 更新 holdings：加权平均买入时间
      if (!holdings[code]) {
        holdings[code] = { pct: newPct, avgBuyTs: t, cat };
      } else {
        const totalPct = holdings[code].pct + delta;
        holdings[code].avgBuyTs = (holdings[code].pct * holdings[code].avgBuyTs + delta * t) / totalPct;
        holdings[code].pct = newPct;
      }
    } else if (delta < -0.1) {
      // 卖出（含减仓和清仓）
      const holdDays = (t - holdings[code].avgBuyTs) / ONE_DAY_MS;
      const redemptionRate = redemptionFeeRate(holdDays);
      totalCost += (Math.abs(delta) / 100) * redemptionRate;
      if (newPct < 0.1) {
        delete holdings[code];
      } else {
        holdings[code].pct = newPct;
      }
    } else if (newPct > 0) {
      // 持仓基本不变，更新 pct（微调）
      if (holdings[code]) {
        holdings[code].pct = newPct;
      }
    }
  }

  return totalCost;
}

// 无成本模式下，也要维护 holdings（便于下一月 delta 对比）
function updateHoldingsNoCosts(holdings, picks, t) {
  const newPctByCode = {};
  picks.forEach(p => { newPctByCode[p.code] = (newPctByCode[p.code] || 0) + p.pct; });
  const allCodes = new Set([...Object.keys(holdings), ...Object.keys(newPctByCode)]);
  for (const code of allCodes) {
    const newPct = newPctByCode[code] || 0;
    if (newPct < 0.1) {
      delete holdings[code];
    } else {
      holdings[code] = { pct: newPct, avgBuyTs: holdings[code]?.avgBuyTs || t, cat: picks.find(p => p.code === code)?.cat };
    }
  }
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
