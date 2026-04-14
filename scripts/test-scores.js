#!/usr/bin/env node
// 评分算法单元测试
// 用法: node scripts/test-scores.js

// ── Mock 全局依赖 ──
global.RISK_FREE = 2;
global.MARKET_BENCHMARKS = {};
global._catBench = {
  active: { avgR1: 15, avgR3: 30, avgDD: 25, stdR1: 12 },
  index:  { avgR1: 12, avgR3: 25, avgDD: 22, stdR1: 10 },
  bond:   { avgR1: 4,  avgR3: 10, avgDD: 5,  stdR1: 2  },
  qdii:   { avgR1: 18, avgR3: 40, avgDD: 28, stdR1: 15 },
};
global.FUND_VALUATION_MAP = {};
global.INDEX_VALUATION = {};
function getDefaultFee(cat){ return {active:0.15,index:0.012,bond:0.05,money:0,qdii:0.08}[cat]||0.10; }
global.getDefaultFee = getDefaultFee;

// 加载评分模块
const fs = require('fs');
const scoreCode = fs.readFileSync(__dirname + '/../js/score.js', 'utf-8');
eval(scoreCode);

// ── 测试工具 ──
let passed = 0, failed = 0;
function assert(desc, condition, detail=''){
  if(condition){ console.log(`  ✓ ${desc}`); passed++; }
  else { console.error(`  ✗ ${desc}${detail?' → '+detail:''}`); failed++; }
}
function assertRange(desc, val, min, max){
  assert(desc, val >= min && val <= max, `got ${val}, expected [${min}, ${max}]`);
}
function assertOrder(desc, higher, lower){
  assert(desc, higher > lower, `expected ${higher} > ${lower}`);
}

// ── 测试用例 ──

console.log('\n[scoreF]');

const bullFund = { cat:'active', r1:40, r3:80, maxDD:25, maxDD3y:20, size:200, mgrYears:5, fee:0.15 };
const avgFund  = { cat:'active', r1:15, r3:30, maxDD:25, maxDD3y:22, size:100, mgrYears:3, fee:0.15 };
const bearFund = { cat:'active', r1:-15, r3:-20, maxDD:40, maxDD3y:38, size:50, mgrYears:1, fee:0.15 };
const dualNeg  = { cat:'active', r1:-10, r3:-25, maxDD:45, maxDD3y:42, size:30, mgrYears:1, fee:0.15 };

const s_bull = scoreF(bullFund);
const s_avg  = scoreF(avgFund);
const s_bear = scoreF(bearFund);

assertRange('牛市基金得分在合理范围', s_bull, 50, 100);
assertRange('平均基金得分在合理范围', s_avg, 30, 80);
assertRange('熊市基金得分在合理范围', s_bear, 0, 60);
assertOrder('牛市基金 > 平均基金', s_bull, s_avg);
assertOrder('平均基金 > 熊市基金', s_avg, s_bear);
assert('scoreF 不返回 NaN', !isNaN(s_bull) && !isNaN(s_avg) && !isNaN(s_bear));
assert('scoreF 不超出 [0,100]', [s_bull,s_avg,s_bear].every(s=>s>=0&&s<=100));

// 近涨远跌 vs 近跌远涨
const nearUp_farDown = { cat:'active', r1:20, r3:-10, maxDD:30, maxDD3y:28, size:100, mgrYears:3, fee:0.15 };
const nearDown_farUp = { cat:'active', r1:-5,  r3:25,  maxDD:30, maxDD3y:25, size:100, mgrYears:3, fee:0.15 };
assertOrder('近跌远涨 > 近涨远跌（dirConsistency）', scoreF(nearDown_farUp), scoreF(nearUp_farDown));

// 数据缺失回退
const noData = { cat:'active', r1:0, r3:0, maxDD:0, size:0, mgrYears:0 };
assert('数据缺失不崩溃', !isNaN(scoreF(noData)));

console.log('\n[calcDCAScore]');

const dcaBull  = { cat:'active', r1:40, r3:80, maxDD:25, maxDD3y:20, mgrYears:5, monthlyReturns: Array(24).fill(3) };
const dcaBond  = { cat:'bond',   r1:5,  r3:12, maxDD:4,  maxDD3y:3,  mgrYears:4, monthlyReturns: Array(24).fill(0.4) };
const dcaDualN = { cat:'active', r1:-10, r3:-25, maxDD:45, maxDD3y:42, mgrYears:1 };
const dcaMoney = { cat:'money',  r1:2,  r3:6,  maxDD:0 };

const d_bull  = calcDCAScore(dcaBull);
const d_bond  = calcDCAScore(dcaBond);
const d_dualN = calcDCAScore(dcaDualN);
const d_money = calcDCAScore(dcaMoney);

assert('calcDCAScore 不返回 NaN', [d_bull,d_bond,d_dualN,d_money].every(s=>!isNaN(s)));
assert('calcDCAScore 不超出 [0,100]', [d_bull,d_bond,d_dualN,d_money].every(s=>s>=0&&s<=100));
assert('货币基金定投评分=10', d_money === 10);
assertRange('双负基金定投评分 ≤ 15', d_dualN, 0, 15);
assertOrder('牛市基金定投 > 双负基金', d_bull, d_dualN);
assertRange('债券基金定投评分合理', d_bond, 10, 80);

// qualityScore 不应为 NaN（之前的 bug）
const noDD = { cat:'active', r1:10, r3:20, maxDD:0, maxDD3y:0, mgrYears:3 };
assert('maxDD=0 时 calcDCAScore 不返回 NaN', !isNaN(calcDCAScore(noDD)));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if(failed > 0) process.exit(1);
