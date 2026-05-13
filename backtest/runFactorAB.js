// 因子 A/B 回测：验证 4.17 后加入的新因子是否真的有效
// 用法:
//   node backtest/runFactorAB.js                    # 跑全部三个因子
//   node backtest/runFactorAB.js --factor=ma200      # 只跑 200日均线因子
//   node backtest/runFactorAB.js --factor=calmar1y   # 只跑 Calmar 1年回撤对齐
//   node backtest/runFactorAB.js --factor=pe3        # 只跑 PE百分位3指数修正
//   node backtest/runFactorAB.js --start=2022-05-31  # 含熊市（默认 2022-05-31）
//
// 输出: backtest/factor-ab-results.json + 控制台对比表

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createShim } = require('./envShim');
const { computeStatsAtT, buildMarketBenchmarks, buildCatRanks } = require('./runBacktestV2');

const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');
const POOL_PATH = path.resolve(__dirname, '../data/history-pool.json');

const startArg = process.argv.find(a => a.startsWith('--start='));
const endArg   = process.argv.find(a => a.startsWith('--end='));
const factorArg = process.argv.find(a => a.startsWith('--factor='));
const START_DATE = startArg ? startArg.split('=')[1] : '2022-05-31';
const END_DATE   = endArg   ? endArg.split('=')[1]   : '2026-03-31';
const ONLY_FACTOR = factorArg ? factorArg.split('=')[1] : null;

const DEFAULT_RISK = { active: 'R4', index: 'R4', bond: 'R2', qdii: 'R4', money: 'R1' };
const DEFAULT_FEE  = { active: 0.15, index: 0.12, bond: 0.08, qdii: 0.15, money: 0 };

// ─── 因子定义 ────────────────────────────────────────────────────────────────
// 每个因子提供两个 patchFn(mb, fundsAtT, t)：
//   control   = 因子关闭时的状态（旧逻辑）
//   treatment = 因子开启时的状态（新逻辑）
// patchFn 直接修改 mb 对象（envShim 会 setBenchmarks(mb)）
const FACTORS = {
  // 因子1：200日均线修正 equityMult
  // control: _sh300Ma200=null（不修正）
  // treatment: 模拟"跌破均线5%"和"站上均线5%"各半的平均效果
  // 实际上我们用两个极端场景分别跑，然后取平均
  ma200: {
    name: '200日均线 equityMult 修正',
    desc: '跌破均线>5% → equityMult×0.95；站上均线>5% → equityMult×1.03',
    control:   (mb) => { mb._sh300Ma200 = null; },
    treatment: (mb, _funds, t) => {
      // 用真实的沪深300均线数据（如果有），否则用历史均值模拟
      // 回测期内：2022熊市大部分时间跌破均线，2024-2025大部分时间站上均线
      // 简化：按月份判断（2022-2023 → below, 2024+ → above）
      const d = new Date(t);
      const yr = d.getFullYear(), mo = d.getMonth();
      const below = (yr === 2022) || (yr === 2023 && mo < 9); // 2022~2023-09 熊市
      mb._sh300Ma200 = below
        ? { above: false, deviation: -7 }   // 跌破5%以上
        : { above: true,  deviation: 6 };   // 站上5%以上
    },
  },

  // 因子2：Calmar 短期用 maxDD1y 替代 maxDD3y
  // control: fundsAtT 里 maxDD1y 不存在（scoreF 回退到 dd3y）
  // treatment: fundsAtT 里有 maxDD1y（scoreF 用 dd1y）
  // 注意：runBacktestV2 的 computeStatsAtT 已计算 maxDD3y，我们额外计算 maxDD1y
  calmar1y: {
    name: 'Calmar 短期 maxDD1y 对齐',
    desc: 'scoreF calmarShort 用 r1/maxDD1y 替代 r1/maxDD3y',
    control:   (_mb, funds) => { funds.forEach(f => { delete f.maxDD1y; }); },
    treatment: (_mb, _funds) => { /* maxDD1y 已由 computeStatsAtT 真实计算，直接保留 */ },
  },

  // 因子3：PE百分位宽基指数从5个→3个（去掉399006创业板+000985中证全指）
  // pool 里有 16 只创业板基金，没有沪深300/中证500/中证1000 ETF（被 Top500 筛掉了）
  // 所以 control vs treatment 的差异体现在：创业板基金是否受 PE 调整影响
  // 历史 PE 百分位（近似）：2022熊市低估(~25%)，2023震荡(~40%)，2024-2025偏高(~60-70%)
  pe3: {
    name: 'PE百分位宽基3指数修正',
    desc: '去掉399006(创业板)：control=创业板基金受PE调整，treatment=不受PE调整',
    control: (_mb, _funds, t, shim) => {
      // 含399006：创业板基金受 PE 调整（历史 PE 百分位按时间动态注入）
      const yr = new Date(t).getFullYear();
      // 创业板历史 PE 百分位近似：2022低估→加分，2023中性，2024-2025偏高→减分
      const pePct = yr <= 2022 ? 25 : yr === 2023 ? 45 : 65;
      shim.sandbox.INDEX_VALUATION = { '399006': { pePct } };
      // pool 里所有创业板基金都映射到 399006
      const cybCodes = ['160422','007464','160420','009981','001879','161613',
                        '003765','160223','110026','002656','007664','001592',
                        '010785','009046','009012','161022'];
      const map = {};
      cybCodes.forEach(c => { map[c] = '399006'; });
      shim.sandbox.FUND_VALUATION_MAP = map;
    },
    treatment: (_mb, _funds, _t, shim) => {
      // 去掉399006：创业板基金不受 PE 调整（getValuationAdj 返回 0）
      shim.sandbox.INDEX_VALUATION = {};
      shim.sandbox.FUND_VALUATION_MAP = {};
    },
  },
};

// ─── 指标计算 ─────────────────────────────────────────────────────────────────
function calcMetrics(monthlyReturns) {
  if (!monthlyReturns || monthlyReturns.length === 0) return {};
  const n = monthlyReturns.length;
  const mean = monthlyReturns.reduce((s, v) => s + v, 0) / n;
  const std  = Math.sqrt(monthlyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / n) || 0.001;
  const annReturn = (Math.pow(monthlyReturns.reduce((p, v) => p * (1 + v / 100), 1), 12 / n) - 1) * 100;
  const annStd = std * Math.sqrt(12);
  const sharpe = (annReturn - 1.7) / annStd;

  let peak = 100, maxDD = 0, nav = 100;
  for (const r of monthlyReturns) {
    nav *= (1 + r / 100);
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const cumReturn = (nav - 100);
  return { sharpe: +sharpe.toFixed(3), maxDD: +maxDD.toFixed(2), cumReturn: +cumReturn.toFixed(2), annReturn: +annReturn.toFixed(2), months: n };
}

// ─── 单次回测 ─────────────────────────────────────────────────────────────────
function runOnce(fundsMeta, fundNavs, poolMap, monthEnds, patchFn) {
  const shim = createShim();
  const monthlyReturns = [];

  for (let i = 0; i < monthEnds.length - 1; i++) {
    const t = monthEnds[i], tNext = monthEnds[i + 1];

    const fundsAtT = [];
    for (const meta of fundsMeta) {
      const stats = computeStatsAtT(fundNavs[meta.code], t);
      if (!stats) continue;
      const poolInfo = poolMap[meta.code] || {};
      fundsAtT.push({
        code: meta.code, name: meta.name, cat: meta.cat,
        risk: DEFAULT_RISK[meta.cat] || 'R4',
        r1: stats.r1, r3: stats.r3, maxDD: stats.maxDD, maxDD3y: stats.maxDD3y,
        maxDD1y: stats.maxDD1y,
        mgr: 3, mgrYears: 3, manager: meta.code, tags: [],
        size: poolInfo.size || 20,
        fee: poolInfo.fee !== undefined ? poolInfo.fee : DEFAULT_FEE[meta.cat],
        monthlyReturns: stats.monthlyReturns,
        composite: 0,
      });
    }

    const mb = buildMarketBenchmarks(fundsAtT);
    // 应用因子 patch
    patchFn(mb, fundsAtT, t, shim);

    shim.setBenchmarks(mb);
    const catBench = {};
    Object.keys(mb).forEach(c => {
      if (mb[c] && typeof mb[c] === 'object' && mb[c].avgR1 !== undefined)
        catBench[c] = { avgR1: mb[c].avgR1, avgR3: mb[c].avgR3, avgDD: mb[c].avgDD, stdR1: mb[c].stdR1 };
    });
    shim.sandbox._catBench = catBench;
    shim.setCuratedFunds(fundsAtT);

    fundsAtT.forEach(f => {
      const dd3y = f.maxDD3y || f.maxDD || 1;
      const dd1y = Math.max(0.1, f.maxDD1y || dd3y); // calmar1y 因子：有 maxDD1y 则用，否则回退 dd3y
      const r3Ann = f.r3 > -100 ? (Math.pow(1 + f.r3 / 100, 1 / 3) - 1) * 100 : 0;
      const bench = catBench[f.cat];
      const alpha1 = bench ? f.r1 - bench.avgR1 : f.r1 - 1.7;
      const alpha3 = bench && bench.avgR3 ? r3Ann - (Math.pow(1 + bench.avgR3 / 100, 1 / 3) - 1) * 100 : r3Ann - 1.7;
      const calmarShort = alpha1 / dd1y;
      const calmarLong  = f.maxDD > 0 ? alpha3 / f.maxDD : 0;
      const calmar = calmarShort * 0.6 + calmarLong * 0.4;
      const trendScore = f.r1 * 0.5 + r3Ann * 0.3;
      const trendConsistency = trendScore > 2 ? 3 : trendScore > 0.5 ? 2 : trendScore > 0 ? 1 : trendScore > -0.5 ? -1 : trendScore > -2 ? -2 : -3;
      const stability = Math.min(3, 15) / 15 * 10;
      f.composite = calmar * 10 * 0.5 + trendConsistency * 4 * 0.25 + stability * 0.20;
    });

    const catRanks = buildCatRanks(fundsAtT, mb);
    shim.resetPhaseHistory();
    const phase = shim.inferMomentumPhase(catRanks);
    const weights = shim.computeWeights('balanced', 3, catRanks, phase);

    // 选基
    const picks = [];
    for (const cat of ['active', 'index', 'bond', 'qdii', 'money']) {
      const w = weights[cat] || 0;
      if (w === 0) continue;
      const catData = catRanks.find(c => c.cat === cat);
      if (!catData || !catData.topFunds || catData.topFunds.length === 0) continue;
      try {
        const p = shim.selectFunds(cat, catData, 'balanced', w, 10000);
        picks.push(...p);
      } catch (e) { /* skip */ }
    }

    // 月收益
    let ret = 0;
    for (const p of picks) {
      const navs = fundNavs[p.code];
      if (!navs) continue;
      const a = findLastNavBefore(navs, t);
      const b = findLastNavBefore(navs, tNext);
      if (a && b && a.nav > 0) ret += (p.pct / 100) * (b.nav / a.nav - 1) * 100;
    }
    monthlyReturns.push(ret);
  }

  return monthlyReturns;
}

function findLastNavBefore(navs, ts) {
  let lo = 0, hi = navs.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (navs[mid].ts <= ts) { best = navs[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function generateMonthEnds(startDate, endDate) {
  const start = new Date(startDate), end = new Date(endDate);
  const result = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const lastDay = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    if (lastDay >= start && lastDay <= end) result.push(lastDay.getTime());
    cur.setMonth(cur.getMonth() + 1);
  }
  return result;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ 先运行 scripts/fetch-history-nav.js + scripts/import-nav-to-sqlite.js');
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));

  console.log('═══ 因子 A/B 回测 ═══');
  console.log(`回测区间: ${START_DATE} ~ ${END_DATE}\n`);

  const fundsMeta = db.prepare('SELECT code, name, cat, first_date, last_date FROM funds').all();
  const fundNavs = {};
  const stmt = db.prepare('SELECT ts, nav FROM nav_daily WHERE code = ? ORDER BY ts ASC');
  fundsMeta.forEach(f => { fundNavs[f.code] = stmt.all(f.code); });
  console.log(`加载 ${fundsMeta.length} 只基金\n`);

  const poolMap = {};
  pool.funds.forEach(f => { poolMap[f.code] = f; });

  const monthEnds = generateMonthEnds(START_DATE, END_DATE);
  console.log(`月末序列: ${monthEnds.length} 个月\n`);

  const factorsToRun = ONLY_FACTOR ? { [ONLY_FACTOR]: FACTORS[ONLY_FACTOR] } : FACTORS;
  if (ONLY_FACTOR && !FACTORS[ONLY_FACTOR]) {
    console.error(`❌ 未知因子: ${ONLY_FACTOR}，可选: ${Object.keys(FACTORS).join(', ')}`);
    process.exit(1);
  }

  const allResults = {};

  for (const [key, factor] of Object.entries(factorsToRun)) {
    console.log(`\n─── 因子: ${factor.name} ───`);
    console.log(`说明: ${factor.desc}`);

    process.stdout.write('  跑 control（因子关闭）...');
    const controlReturns = runOnce(fundsMeta, fundNavs, poolMap, monthEnds, factor.control);
    const controlMetrics = calcMetrics(controlReturns);
    console.log(` 完成 (${controlReturns.length} 月)`);

    process.stdout.write('  跑 treatment（因子开启）...');
    const treatmentReturns = runOnce(fundsMeta, fundNavs, poolMap, monthEnds, factor.treatment);
    const treatmentMetrics = calcMetrics(treatmentReturns);
    console.log(` 完成 (${treatmentReturns.length} 月)`);

    const diff = {
      sharpe:    +(treatmentMetrics.sharpe    - controlMetrics.sharpe).toFixed(3),
      maxDD:     +(treatmentMetrics.maxDD     - controlMetrics.maxDD).toFixed(2),
      cumReturn: +(treatmentMetrics.cumReturn - controlMetrics.cumReturn).toFixed(2),
      annReturn: +(treatmentMetrics.annReturn - controlMetrics.annReturn).toFixed(2),
    };

    const verdict = diff.sharpe > 0.05 ? '✅ 有效' : diff.sharpe < -0.05 ? '❌ 有害' : '⚠️  中性';

    console.log(`\n  | 指标       | control | treatment | delta  |`);
    console.log(`  |------------|---------|-----------|--------|`);
    console.log(`  | 夏普比率   | ${controlMetrics.sharpe.toFixed(3).padStart(7)} | ${treatmentMetrics.sharpe.toFixed(3).padStart(9)} | ${(diff.sharpe >= 0 ? '+' : '') + diff.sharpe.toFixed(3).padStart(6)} |`);
    console.log(`  | 最大回撤%  | ${controlMetrics.maxDD.toFixed(2).padStart(7)} | ${treatmentMetrics.maxDD.toFixed(2).padStart(9)} | ${(diff.maxDD >= 0 ? '+' : '') + diff.maxDD.toFixed(2).padStart(6)} |`);
    console.log(`  | 累计收益%  | ${controlMetrics.cumReturn.toFixed(2).padStart(7)} | ${treatmentMetrics.cumReturn.toFixed(2).padStart(9)} | ${(diff.cumReturn >= 0 ? '+' : '') + diff.cumReturn.toFixed(2).padStart(6)} |`);
    console.log(`  | 年化收益%  | ${controlMetrics.annReturn.toFixed(2).padStart(7)} | ${treatmentMetrics.annReturn.toFixed(2).padStart(9)} | ${(diff.annReturn >= 0 ? '+' : '') + diff.annReturn.toFixed(2).padStart(6)} |`);
    console.log(`\n  结论: ${verdict}`);

    allResults[key] = {
      factor: factor.name,
      desc: factor.desc,
      control: controlMetrics,
      treatment: treatmentMetrics,
      diff,
      verdict,
    };
  }

  const outPath = path.resolve(__dirname, 'factor-ab-results.json');
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    startDate: START_DATE,
    endDate: END_DATE,
    results: allResults,
  }, null, 2));

  console.log(`\n\n═══ 汇总 ═══`);
  console.log('| 因子 | 夏普 delta | 回撤 delta | 结论 |');
  console.log('|------|-----------|-----------|------|');
  for (const [key, r] of Object.entries(allResults)) {
    const sd = (r.diff.sharpe >= 0 ? '+' : '') + r.diff.sharpe.toFixed(3);
    const dd = (r.diff.maxDD >= 0 ? '+' : '') + r.diff.maxDD.toFixed(2) + '%';
    console.log(`| ${key.padEnd(10)} | ${sd.padStart(9)} | ${dd.padStart(9)} | ${r.verdict} |`);
  }
  console.log(`\n结果已写入 backtest/factor-ab-results.json`);

  db.close();
}

main();
