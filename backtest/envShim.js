// envShim: 在 Node 里加载 js/market.js 和 js/portfolio.js，mock 浏览器环境
// 只暴露纯函数 inferMomentumPhase 和 computeWeights，其余全局是隔离的
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createShim() {
  const mockStorage = new Map();
  const localStorage = {
    getItem: (k) => mockStorage.has(k) ? mockStorage.get(k) : null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
    removeItem: (k) => mockStorage.delete(k),
    clear: () => mockStorage.clear(),
  };

  const sandbox = {
    // 基础内置
    console, Math, JSON, Object, Array, String, Number, Boolean, Date,
    parseFloat, parseInt, isNaN, isFinite,
    // mock
    localStorage,
    window: {},
    document: { getElementById: () => null },
    // index.html 内联全局（score.js/market.js 里被引用）
    navCache: {},
    RISK_FREE: 1.7,
    _catBench: {},
    // config.js 会定义这些，但我们不加载 config.js（避免 FUND_VALUATION_MAP 等无关内容）
    // 所以手动定义 market.js 和 portfolio.js 需要的常量
    CURATED_FUNDS: [],
    MARKET_BENCHMARKS: {},
    DD_TO_VOL: { active: 2.8, index: 3.0, bond: 1.8, money: 1.2, qdii: 2.5 },
    CAT_NAMES: { active: '主动权益', index: '指数基金', bond: '债券基金', money: '货币基金', qdii: 'QDII海外' },
    // config.js 里定义的暂停基金检查：回测里没人暂停申购，直接返回原 code
    SUSPENDED_FUNDS: new Set(),
    FUND_ALTERNATIVES: {},
    checkFundAvailability: (code) => code,
    getDefaultFee: (cat) => ({ active: 0.15, index: 0.012, bond: 0.05, money: 0, qdii: 0.08 }[cat] || 0.10),
    // V2.C 回测需要：FUND_VALUATION_MAP 置空则 getValuationAdj 返回 0（不做估值调整）
    FUND_VALUATION_MAP: {},
    INDEX_VALUATION: {},
    // 辅助：重置 phase 历史，保证每次回测从干净状态开始
    _resetPhaseHistory: () => mockStorage.clear(),
  };

  const context = vm.createContext(sandbox);

  // 加载需要的源文件
  const repoRoot = path.resolve(__dirname, '..');
  const files = ['js/market.js', 'js/portfolio.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    vm.runInContext(src, context, { filename: f });
  }

  return {
    sandbox,
    inferMomentumPhase: sandbox.inferMomentumPhase,
    computeWeights: sandbox.computeWeights,
    selectFunds: sandbox.selectFunds,
    resetPhaseHistory: () => mockStorage.clear(),
    setBenchmarks: (mb) => { sandbox.MARKET_BENCHMARKS = mb; context.MARKET_BENCHMARKS = mb; },
    setCuratedFunds: (funds) => { sandbox.CURATED_FUNDS = funds; context.CURATED_FUNDS = funds; },
  };
}

module.exports = { createShim };

// 快速自测：node backtest/envShim.js
if (require.main === module) {
  const shim = createShim();
  // 注入极简基准
  shim.setBenchmarks({
    active: { avgR1: 10, avgR3: 20, stdR1: 15, avgDD: 30, monthlyReturns: [1, -2, 3, 0, 1, 2, -1, 0, 1, 2, -1, 3] },
    index:  { avgR1: 8,  avgR3: 15, stdR1: 12, avgDD: 25, monthlyReturns: [0.5, -1, 2, 0, 0.5, 1, -0.5, 0, 1, 1, -0.5, 2] },
    bond:   { avgR1: 3,  avgR3: 9,  stdR1: 2,  avgDD: 3,  monthlyReturns: [0.2, 0.1, 0.3, 0.2, 0.1, 0.3, 0.2, 0.1, 0.3, 0.2, 0.1, 0.3] },
    qdii:   { avgR1: 12, avgR3: 25, stdR1: 18, avgDD: 35, monthlyReturns: [1.5, -2, 3, 0.5, 1, 2, -1, 0.5, 1, 2, -1, 3] },
    money:  { avgR1: 2,  avgR3: 6,  stdR1: 0.1, avgDD: 0, monthlyReturns: Array(12).fill(0.15) },
  });
  const catRanks = [
    { cat: 'active', avgR1: 10, avgR3: 20, avgDD: 30, avgChg: 0.1, catScore: 5, topFunds: [] },
    { cat: 'index',  avgR1: 8,  avgR3: 15, avgDD: 25, avgChg: 0.05, catScore: 4, topFunds: [] },
    { cat: 'bond',   avgR1: 3,  avgR3: 9,  avgDD: 3,  avgChg: 0.02, catScore: 2, topFunds: [] },
    { cat: 'qdii',   avgR1: 12, avgR3: 25, avgDD: 35, avgChg: 0.15, catScore: 6, topFunds: [] },
    { cat: 'money',  avgR1: 2,  avgR3: 6,  avgDD: 0,  avgChg: 0,    catScore: 1, topFunds: [] },
  ];
  const phase = shim.inferMomentumPhase(catRanks);
  const weights = shim.computeWeights('balanced', 5, catRanks, phase);
  console.log('phase:', phase.phase, phase.label);
  console.log('weights:', weights);
}
