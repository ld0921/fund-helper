#!/usr/bin/env node
// 3.4 诊断：对比 scoreF 和 composite 在 V2 数据下的排名相关性
// 用法：node backtest/diag-score-vs-composite.js

const { DatabaseSync } = require('node:sqlite');
const { createShim } = require('./envShim');
const {
  computeStatsAtT, buildMarketBenchmarks, buildCatRanks,
} = require('./runBacktestV2');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');
const POOL_PATH = path.resolve(__dirname, '../data/history-pool.json');

function computeComposite(f, bench) {
  const dd3y = f.maxDD3y || f.maxDD || 1;
  const r3Ann = f.r3 > -100 ? (Math.pow(1 + f.r3/100, 1/3) - 1) * 100 : 0;
  const alpha1 = bench ? f.r1 - bench.avgR1 : f.r1 - 1.7;
  const alpha3 = bench && bench.avgR3 ? r3Ann - (Math.pow(1 + bench.avgR3/100, 1/3) - 1) * 100 : r3Ann - 1.7;
  const calmarShort = dd3y > 0 ? alpha1 / dd3y : 0;
  const calmarLong = f.maxDD > 0 ? alpha3 / f.maxDD : 0;
  const calmar = calmarShort * 0.6 + calmarLong * 0.4;
  const trendScore = 0 + f.r1 * 0.5 + r3Ann * 0.3;
  const trendConsistency = trendScore > 2 ? 3 : trendScore > 0.5 ? 2 : trendScore > 0 ? 1 : trendScore > -0.5 ? -1 : trendScore > -2 ? -2 : -3;
  const stability = Math.min(f.mgrYears, 15) / 15 * 10;
  return calmar * 10 * 0.5 + trendConsistency * 4 * 0.25 + stability * 0.20;
}

// 额外在 shim 里暴露 scoreF
function createScoreFShim() {
  const shim = createShim();
  const scoreJsSrc = fs.readFileSync(path.resolve(__dirname, '../js/score.js'), 'utf8');
  const context = vm.createContext(shim.sandbox);
  vm.runInContext(scoreJsSrc, context, { filename: 'js/score.js' });
  return { ...shim, scoreF: shim.sandbox.scoreF };
}

// Pearson 相关系数
function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a,b)=>a+b,0)/n;
  const my = y.reduce((a,b)=>a+b,0)/n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]-mx)*(y[i]-my);
    dx += (x[i]-mx)**2;
    dy += (y[i]-my)**2;
  }
  return dx > 0 && dy > 0 ? num/Math.sqrt(dx*dy) : 0;
}

// Spearman 相关（排名相关）
function spearman(x, y) {
  const rankOf = arr => {
    const indexed = arr.map((v,i) => ({v,i}));
    indexed.sort((a,b) => a.v - b.v);
    const ranks = new Array(arr.length);
    indexed.forEach((item, rank) => { ranks[item.i] = rank; });
    return ranks;
  };
  return pearson(rankOf(x), rankOf(y));
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

  const shim = createScoreFShim();
  const DEFAULT_RISK = { active:'R4', index:'R4', bond:'R2', qdii:'R4', money:'R1' };
  const DEFAULT_FEE = { active:0.15, index:0.12, bond:0.08, qdii:0.15, money:0 };
  const DEFAULT_MGR = 3;
  const DEFAULT_SIZE = 20;

  // 取 3 个代表时点：2024-04-30（旧基线）、2022-12-31（熊市底）、2026-03-31（最新）
  const timepoints = [
    { label: '2022-12-31 熊市底', t: new Date('2022-12-31').getTime() },
    { label: '2024-04-30 前一基线', t: new Date('2024-04-30').getTime() },
    { label: '2026-03-31 最新', t: new Date('2026-03-31').getTime() },
  ];

  console.log('═══ 3.4: scoreF vs composite 排名相关性诊断 ═══\n');

  for (const tp of timepoints) {
    console.log(`\n── 时点：${tp.label} ──`);
    const fundsAtT = [];
    for (const meta of fundsMeta) {
      const stats = computeStatsAtT(fundNavs[meta.code], tp.t);
      if (!stats) continue;
      const poolInfo = poolMap[meta.code] || {};
      fundsAtT.push({
        code: meta.code, name: meta.name, cat: meta.cat,
        risk: DEFAULT_RISK[meta.cat] || 'R4',
        r1: stats.r1, r3: stats.r3, maxDD: stats.maxDD, maxDD3y: stats.maxDD3y,
        mgr: DEFAULT_MGR, mgrYears: DEFAULT_MGR, manager: meta.code, tags: [],
        size: poolInfo.size || DEFAULT_SIZE,
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

    // 计算两套分数
    fundsAtT.forEach(f => {
      f.composite = computeComposite(f, catBench[f.cat]);
      try { f.scoreF = shim.scoreF(f); } catch(e) { f.scoreF = 0; }
    });

    // 按类别算相关性
    ['active', 'index', 'bond', 'qdii'].forEach(cat => {
      const list = fundsAtT.filter(f => f.cat === cat);
      if (list.length < 5) return;
      const comp = list.map(f => f.composite);
      const sf = list.map(f => f.scoreF);
      const r = pearson(comp, sf);
      const rho = spearman(comp, sf);

      // top-10 对比
      const byComp = [...list].sort((a,b) => b.composite - a.composite).slice(0, 10).map(f => f.code);
      const byScoreF = [...list].sort((a,b) => b.scoreF - a.scoreF).slice(0, 10).map(f => f.code);
      const overlap = byComp.filter(c => byScoreF.includes(c)).length;

      console.log(`  ${cat.padEnd(7)} n=${list.length.toString().padStart(3)} Pearson=${r.toFixed(3)} Spearman=${rho.toFixed(3)} · Top10 重合 ${overlap}/10`);
    });

    // 展示最不一致的案例（composite 高但 scoreF 低 或反之）
    const discordant = fundsAtT
      .filter(f => f.cat === 'active')
      .map(f => {
        const list = fundsAtT.filter(x => x.cat === 'active');
        const compRank = list.slice().sort((a,b)=>b.composite-a.composite).findIndex(x => x.code === f.code) + 1;
        const sfRank = list.slice().sort((a,b)=>b.scoreF-a.scoreF).findIndex(x => x.code === f.code) + 1;
        return { ...f, compRank, sfRank, diff: Math.abs(compRank - sfRank) };
      })
      .sort((a,b) => b.diff - a.diff)
      .slice(0, 3);
    console.log(`  · active 最不一致案例（composite vs scoreF 排名差距）:`);
    discordant.forEach(f => {
      console.log(`    ${f.code} ${f.name.slice(0,15).padEnd(15)} composite#${f.compRank} scoreF#${f.sfRank} (差 ${f.diff}) · r1=${f.r1.toFixed(1)}% r3=${f.r3.toFixed(1)}% maxDD=${f.maxDD.toFixed(1)}%`);
    });
  }

  db.close();
}

if (require.main === module) main();
