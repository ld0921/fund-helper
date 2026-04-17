// 回测引擎核心
// 输入：curated-details.json 的 marketBenchmarks.monthlyReturns (36 个月 × 4 类)
// 输出：7 个画像各自的月度组合收益序列 + phase 轨迹
const fs = require('fs');
const path = require('path');
const { createShim } = require('./envShim');

const CATS = ['active', 'index', 'bond', 'qdii', 'money'];

function loadData() {
  const p = path.resolve(__dirname, '../data/curated-details.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mb = raw.marketBenchmarks;
  // monthlyReturns 是最近 36 个月（按时间正序）
  const seqs = {};
  CATS.forEach(c => {
    if (mb[c] && mb[c].monthlyReturns) seqs[c] = mb[c].monthlyReturns.slice();
    else seqs[c] = null;
  });
  // 货币基金无月度序列：按年化 2% 折月（简化常数）
  if (!seqs.money) {
    const monthsLen = Math.max(...Object.values(seqs).filter(Boolean).map(s => s.length));
    seqs.money = Array(monthsLen).fill(Math.pow(1.02, 1/12) - 1).map(x => x * 100); // 百分比
  }
  return {
    seqs,
    bondYield: raw.bondYield || 1.5,
    totalMonths: Math.min(...Object.values(seqs).map(s => s.length)),
  };
}

// 在时点 t 用过去 windowSize 个月重建 MARKET_BENCHMARKS（注意：monthlyReturns 是百分比）
function rebuildBenchmarks(seqs, t, windowSize) {
  const mb = { _bondYield: null };
  CATS.forEach(c => {
    const s = seqs[c];
    if (!s || t < windowSize) { mb[c] = null; return; }
    const window = s.slice(t - windowSize, t);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);
    // avgR1: 近 12 个月累计（连乘）
    const r1Window = s.slice(Math.max(0, t - 12), t);
    let cumR1 = 1; r1Window.forEach(r => cumR1 *= (1 + r / 100));
    const avgR1 = (cumR1 - 1) * 100;
    // avgR3: 近 36 个月累计，窗口不够时按 avgR1 折算
    let avgR3 = null;
    if (t >= 36) {
      const r3Window = s.slice(t - 36, t);
      let cumR3 = 1; r3Window.forEach(r => cumR3 *= (1 + r / 100));
      avgR3 = (cumR3 - 1) * 100;
    } else {
      // 用窗口期折算（年化再乘 3）
      const n = window.length;
      let cum = 1; window.forEach(r => cum *= (1 + r / 100));
      const annualized = (Math.pow(cum, 12 / n) - 1) * 100;
      avgR3 = (Math.pow(1 + annualized / 100, 3) - 1) * 100;
    }
    // avgDD: 近 36 个月滚动峰值回撤，窗口不够用 window
    const ddWindow = t >= 36 ? s.slice(t - 36, t) : window;
    let peak = 1, cum = 1, maxDD = 0;
    ddWindow.forEach(r => {
      cum *= (1 + r / 100);
      if (cum > peak) peak = cum;
      const dd = (peak - cum) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    });
    mb[c] = {
      avgR1, avgR3, stdR1: std, avgDD: maxDD,
      monthlyReturns: window.slice(), // 供 computeWeights 动态相关性矩阵用
      count: window.length,
    };
  });
  return mb;
}

// 从 benchmarks 构造 catRanks（computeWeights 需要）
function buildCatRanks(mb, seqs, t) {
  const ranks = CATS.map(cat => {
    const b = mb[cat];
    if (!b) return null;
    const avgChg = 0; // 月度回测无"今日"概念，置 0
    // catScore 用简化 Calmar 排序（不调 analyzeCategoryPerf）
    const r3Ann = b.avgR3 > -100 ? (Math.pow(1 + b.avgR3 / 100, 1/3) - 1) * 100 : 0;
    const catScore = b.avgDD > 0 ? r3Ann / b.avgDD * 10 : r3Ann;
    return {
      cat, name: cat, avgR1: b.avgR1, avgR3: b.avgR3,
      stdR1: b.stdR1, avgDD: b.avgDD, avgChg,
      catScore, topFunds: [],
      avgCalmar: b.avgDD > 0 ? r3Ann / b.avgDD : 0,
      catTrend: b.avgR1 > 0 ? 2 : -2,
    };
  }).filter(Boolean);
  return ranks.sort((a, b) => b.catScore - a.catScore);
}

// 按权重持有一个月，返回组合月度收益 (%)
function monthReturn(weights, seqs, t) {
  let ret = 0;
  Object.keys(weights).forEach(cat => {
    const r = seqs[cat] ? seqs[cat][t] : 0;
    ret += (weights[cat] / 100) * r;
  });
  return ret;
}

// 主回测函数
function runPortfolio(name, profile, data, options = {}) {
  const { seqs, totalMonths } = data;
  const { riskProfile, horizon, overridePhase = null, skipMomentum = false } = profile;
  const shim = createShim();

  const windowSize = 12; // 前 12 个月做初始窗口
  const monthlyReturns = [];
  const phases = [];
  const weightHistory = [];

  shim.resetPhaseHistory();

  for (let t = windowSize; t < totalMonths; t++) {
    const mb = rebuildBenchmarks(seqs, t, windowSize);
    // 注入 bondYield（inferMomentumPhase 会读）
    mb._bondYield = data.bondYield;
    shim.setBenchmarks(mb);
    const catRanks = buildCatRanks(mb, seqs, t);

    let macroClock;
    if (overridePhase) {
      // 固定 phase 基线
      macroClock = overridePhase;
    } else if (skipMomentum) {
      // 纯风险平价：phase 未知，乘数为 1
      macroClock = { phase: 'unknown', equityMult: 1.0, bondMult: 1.0 };
    } else {
      macroClock = shim.inferMomentumPhase(catRanks);
    }

    let weights;
    if (options.fixedWeights) {
      weights = options.fixedWeights;
    } else {
      weights = shim.computeWeights(riskProfile, horizon, catRanks, macroClock);
    }

    const ret = monthReturn(weights, seqs, t);
    monthlyReturns.push(ret);
    phases.push(macroClock.phase);
    weightHistory.push({ t, weights, phase: macroClock.phase });
  }

  return { name, profile, monthlyReturns, phases, weightHistory };
}

function main() {
  const data = loadData();
  console.log(`数据：${data.totalMonths} 个月，类别 ${Object.keys(data.seqs).filter(c => data.seqs[c]).join(',')}`);

  // 7 组 distinct 画像
  const profiles = [
    { name: '平衡+1年', riskProfile: 'balanced', horizon: 1 },
    { name: '平衡+2年', riskProfile: 'balanced', horizon: 2 },
    { name: '平衡+3年', riskProfile: 'balanced', horizon: 3 },
    { name: '进取+1年', riskProfile: 'aggressive', horizon: 1 },
    { name: '进取+2年', riskProfile: 'aggressive', horizon: 2 },
    { name: '进取+3年', riskProfile: 'aggressive', horizon: 3 },
    { name: '进取+5年', riskProfile: 'aggressive', horizon: 5 },
  ];

  const results = [];
  for (const p of profiles) {
    const r = runPortfolio(p.name, p, data);
    results.push(r);
    const total = r.monthlyReturns.reduce((a, b) => a + b, 0);
    console.log(`  [${p.name}] 月数=${r.monthlyReturns.length} 简单累计=${total.toFixed(2)}% phase分布=${summarizePhases(r.phases)}`);
  }

  // 4 条基线
  const baselines = [
    { name: '基线：等权 25%×4', riskProfile: 'balanced', horizon: 5,
      options: { fixedWeights: { active: 25, index: 25, bond: 25, qdii: 25, money: 0 } } },
    { name: '基线：60/40 股债', riskProfile: 'balanced', horizon: 5,
      options: { fixedWeights: { active: 30, index: 30, bond: 40, qdii: 0, money: 0 } } },
    { name: '基线：纯风险平价(去动量)', riskProfile: 'balanced', horizon: 5,
      options: {}, skipMomentum: true },
    { name: '基线：永久recovery', riskProfile: 'balanced', horizon: 5,
      options: {}, overridePhase: { phase: 'recovery', equityMult: 1.10, bondMult: 0.93 } },
  ];

  for (const b of baselines) {
    const profile = { riskProfile: b.riskProfile, horizon: b.horizon,
      overridePhase: b.overridePhase, skipMomentum: b.skipMomentum };
    const r = runPortfolio(b.name, profile, data, b.options || {});
    results.push(r);
    const total = r.monthlyReturns.reduce((a, b) => a + b, 0);
    console.log(`  [${b.name}] 简单累计=${total.toFixed(2)}%`);
  }

  // 输出 JSON 供报告页使用
  const out = path.resolve(__dirname, 'results.json');
  fs.writeFileSync(out, JSON.stringify({
    dataTimestamp: new Date().toISOString(),
    totalMonths: data.totalMonths,
    windowSize: 12,
    results: results.map(r => ({
      name: r.name,
      profile: r.profile,
      monthlyReturns: r.monthlyReturns,
      phases: r.phases,
      weightHistory: r.weightHistory,
    })),
    seqs: data.seqs,
  }, null, 2));
  console.log(`\n✓ 结果已写入 ${path.relative(path.resolve(__dirname, '..'), out)}`);
  return results;
}

function summarizePhases(phases) {
  const count = {};
  phases.forEach(p => count[p] = (count[p] || 0) + 1);
  return Object.entries(count).map(([k, v]) => `${k}:${v}`).join(' ');
}

if (require.main === module) {
  main();
}

module.exports = { runPortfolio, loadData, rebuildBenchmarks, buildCatRanks, monthReturn };
