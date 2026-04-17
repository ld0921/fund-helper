#!/usr/bin/env node
// 3.5 验证 calculateRebalanceCost 里 expectedGainRate = scoreDiff * 0.0015 的系数
// 方法：多时点对同类别基金计算 scoreF，与后 12 个月累计收益做回归，斜率即真实系数
// 用法：node backtest/diag-scoref-coefficient.js

const { DatabaseSync } = require('node:sqlite');
const { createShim } = require('./envShim');
const {
  computeStatsAtT, buildMarketBenchmarks,
} = require('./runBacktestV2');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');
const POOL_PATH = path.resolve(__dirname, '../data/history-pool.json');
const ONE_DAY = 24 * 60 * 60 * 1000;

function forwardReturn12m(navs, t) {
  const tFuture = t + 365.25 * ONE_DAY;
  const navAtT = navs.filter(p => p.ts <= t).slice(-1)[0];
  const navAtFuture = navs.filter(p => p.ts <= tFuture).slice(-1)[0];
  if (!navAtT || !navAtFuture || navAtT.nav <= 0) return null;
  // 必须 tFuture 比 t 晚足够
  if (navAtFuture.ts - navAtT.ts < 300 * ONE_DAY) return null;
  return (navAtFuture.nav / navAtT.nav - 1) * 100;
}

// 简单线性回归 y = a + b*x, 返回 {slope, intercept, r2, n}
function linReg(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s,v)=>s+v,0)/n;
  const my = ys.reduce((s,v)=>s+v,0)/n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]-mx)*(ys[i]-my);
    dx2 += (xs[i]-mx)**2;
    dy2 += (ys[i]-my)**2;
  }
  if (dx2 === 0) return null;
  const slope = num / dx2;
  const intercept = my - slope * mx;
  const r2 = (num ** 2) / (dx2 * dy2);
  return { slope, intercept, r2, n };
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const fundsMeta = db.prepare('SELECT code, name, cat, first_date, last_date FROM funds').all();
  const fundNavs = {};
  const stmt = db.prepare('SELECT ts, nav FROM nav_daily WHERE code = ? ORDER BY ts ASC');
  fundsMeta.forEach(f => { fundNavs[f.code] = stmt.all(f.code); });
  const poolMap = {};
  pool.funds.forEach(f => { poolMap[f.code] = f; });

  const shim = createShim();
  const DEFAULT_RISK = { active:'R4', index:'R4', bond:'R2', qdii:'R4', money:'R1' };
  const DEFAULT_FEE = { active:0.15, index:0.12, bond:0.08, qdii:0.15, money:0 };

  // 多个评估时点（每个时点需要后续 1 年数据，所以最晚到 2025-03 起）
  const timepoints = [
    { label: '2022-05-31', t: new Date('2022-05-31').getTime() },
    { label: '2022-11-30', t: new Date('2022-11-30').getTime() },
    { label: '2023-05-31', t: new Date('2023-05-31').getTime() },
    { label: '2023-11-30', t: new Date('2023-11-30').getTime() },
    { label: '2024-05-31', t: new Date('2024-05-31').getTime() },
    { label: '2024-11-30', t: new Date('2024-11-30').getTime() },
    { label: '2025-03-31', t: new Date('2025-03-31').getTime() },
  ];

  console.log('═══ 3.5 · scoreF 预测能力验证 ═══');
  console.log('每分 scoreF 差 → 多少后续 12 月累计收益差？\n');
  console.log('当前生产代码假设：scoreDiff × 0.0015 ⇒ 每分 0.15% 年化差\n');

  const allData = []; // 所有样本 (x=scoreF, y=forward12m, cat, time)

  for (const tp of timepoints) {
    // 构造 fundsAtT
    const fundsAtT = [];
    for (const meta of fundsMeta) {
      const stats = computeStatsAtT(fundNavs[meta.code], tp.t);
      if (!stats) continue;
      const poolInfo = poolMap[meta.code] || {};
      fundsAtT.push({
        code: meta.code, name: meta.name, cat: meta.cat,
        risk: DEFAULT_RISK[meta.cat] || 'R4',
        r1: stats.r1, r3: stats.r3, maxDD: stats.maxDD, maxDD3y: stats.maxDD3y,
        mgr: 3, mgrYears: 3, manager: meta.code, tags: [],
        size: poolInfo.size || 20,
        fee: poolInfo.fee !== undefined ? poolInfo.fee : DEFAULT_FEE[meta.cat],
        monthlyReturns: stats.monthlyReturns,
      });
    }

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

    // 每只算 scoreF 和后 12 月收益
    for (const f of fundsAtT) {
      try { f.scoreF = shim.scoreF(f); } catch(e) { continue; }
      const fwd = forwardReturn12m(fundNavs[f.code], tp.t);
      if (fwd === null || !isFinite(f.scoreF)) continue;
      allData.push({ cat: f.cat, time: tp.label, scoreF: f.scoreF, fwd12m: fwd });
    }
  }

  // 按类别回归
  console.log('| 类别 | 样本数 | 斜率 b | 截距 a | R² | 每分对应% | vs 0.15% 假设 |');
  console.log('|---|---|---|---|---|---|---|');
  const cats = ['active', 'index', 'bond', 'qdii'];
  cats.forEach(cat => {
    const catData = allData.filter(d => d.cat === cat);
    if (catData.length < 20) {
      console.log(`| ${cat} | ${catData.length} | 样本不足 |`);
      return;
    }
    const xs = catData.map(d => d.scoreF);
    const ys = catData.map(d => d.fwd12m);
    const lr = linReg(xs, ys);
    const slopePercent = lr.slope; // %每分
    const vsAssumption = slopePercent / 0.15;
    console.log(`| ${cat} | ${lr.n} | ${lr.slope.toFixed(3)} | ${lr.intercept.toFixed(1)} | ${lr.r2.toFixed(3)} | ${slopePercent.toFixed(3)}% | ${vsAssumption.toFixed(2)}× |`);
  });

  // 全样本
  console.log('');
  const xs = allData.map(d => d.scoreF);
  const ys = allData.map(d => d.fwd12m);
  const lr = linReg(xs, ys);
  console.log(`全样本: n=${lr.n} · 斜率=${lr.slope.toFixed(3)}%/分 · R²=${lr.r2.toFixed(3)}`);
  console.log(`        每分 scoreF 对应 ${lr.slope.toFixed(3)}% 后 12 月收益差`);
  console.log(`        代码假设 0.15%，真实系数是 ${(lr.slope/0.15).toFixed(2)}× 假设值`);
  console.log('');
  console.log(`建议: 将 calculateRebalanceCost 里 0.0015 改为 ${(lr.slope/100).toFixed(4)}`);

  // 分组对比：top/mid/bot 三分位
  console.log('\n── 三分位分组验证 ──');
  cats.forEach(cat => {
    const catData = allData.filter(d => d.cat === cat);
    if (catData.length < 30) return;
    const sorted = catData.slice().sort((a,b) => b.scoreF - a.scoreF);
    const third = Math.floor(sorted.length / 3);
    const top = sorted.slice(0, third);
    const mid = sorted.slice(third, 2*third);
    const bot = sorted.slice(2*third);
    const meanFwd = arr => arr.reduce((s,d) => s+d.fwd12m, 0) / arr.length;
    const meanScore = arr => arr.reduce((s,d) => s+d.scoreF, 0) / arr.length;
    console.log(`  ${cat.padEnd(7)} Top: ${meanFwd(top).toFixed(1)}% (score~${meanScore(top).toFixed(0)}) · Mid: ${meanFwd(mid).toFixed(1)}% (score~${meanScore(mid).toFixed(0)}) · Bot: ${meanFwd(bot).toFixed(1)}% (score~${meanScore(bot).toFixed(0)}) · Top-Bot = ${(meanFwd(top) - meanFwd(bot)).toFixed(1)}pp`);
  });

  db.close();
}

if (require.main === module) main();
