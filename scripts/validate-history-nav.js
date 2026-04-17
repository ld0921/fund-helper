#!/usr/bin/env node
// 质量验证：从 SQLite 重算样本基金的 r1/r3/maxDD，与 curated-details.json 当前值对比
// 如果差异 > 5%，说明数据有问题
//
// 用法: node scripts/validate-history-nav.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');
const CURATED_PATH = path.resolve(__dirname, '../data/curated-details.json');

function computeStats(navPoints, endTs) {
  // navPoints: [{ ts, nav }]，已按 ts 升序
  if (navPoints.length < 10) return null;

  // r1: 近 1 年累计收益率
  const oneYearAgo = endTs - 365.25 * 24 * 60 * 60 * 1000;
  const navsR1 = navPoints.filter(p => p.ts >= oneYearAgo);
  const r1 = navsR1.length >= 2 ? (navsR1[navsR1.length - 1].nav / navsR1[0].nav - 1) * 100 : null;

  // r3: 近 3 年累计收益率
  const threeYearsAgo = endTs - 3 * 365.25 * 24 * 60 * 60 * 1000;
  const navsR3 = navPoints.filter(p => p.ts >= threeYearsAgo);
  const r3 = navsR3.length >= 2 ? (navsR3[navsR3.length - 1].nav / navsR3[0].nav - 1) * 100 : null;

  // maxDD3y: 近 3 年最大回撤
  let peak = 0, maxDD = 0;
  navsR3.forEach(p => {
    if (p.nav > peak) peak = p.nav;
    if (peak > 0) {
      const dd = (peak - p.nav) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
  });

  return { r1, r3, maxDD3y: maxDD };
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('❌ 先运行 import-nav-to-sqlite.js'); process.exit(1); }
  if (!fs.existsSync(CURATED_PATH)) { console.error('❌ 缺少 curated-details.json'); process.exit(1); }

  const db = new DatabaseSync(DB_PATH);
  const curated = JSON.parse(fs.readFileSync(CURATED_PATH, 'utf8'));
  const curatedFunds = curated.funds || {};

  // 挑和 curated 都有的基金做对比
  const commonCodes = Object.keys(curatedFunds).filter(code => {
    const row = db.prepare('SELECT code FROM funds WHERE code = ?').get(code);
    return !!row;
  });

  console.log(`═══ 质量验证 ═══`);
  console.log(`  curated-details 有 ${Object.keys(curatedFunds).length} 只`);
  console.log(`  history DB 有 ${db.prepare('SELECT COUNT(*) as n FROM funds').get().n} 只`);
  console.log(`  交集 ${commonCodes.length} 只可用于对比\n`);

  if (commonCodes.length === 0) {
    console.log('⚠️ 交集为空，无法直接验证。打印 history DB 样本作为参考：');
    const sample = db.prepare('SELECT code, name, first_date, last_date, point_count FROM funds LIMIT 10').all();
    sample.forEach(r => console.log(`    ${r.code} ${r.name} ${r.first_date}~${r.last_date} (${r.point_count} pts)`));
    db.close();
    return;
  }

  const nowTs = Date.now();
  console.log(`| 代码 | 名称 | curated r1 | 重算 r1 | Δ | curated r3 | 重算 r3 | Δ | curated maxDD3y | 重算 | Δ |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);

  let r1Errors = [], r3Errors = [], ddErrors = [];
  const samples = commonCodes.slice(0, 20); // 最多展示 20 只

  samples.forEach(code => {
    const cur = curatedFunds[code];
    const navs = db.prepare('SELECT ts, nav FROM nav_daily WHERE code = ? ORDER BY ts ASC').all(code);
    const stats = computeStats(navs, nowTs);
    if (!stats) { console.log(`| ${code} | 数据不足 |`); return; }

    const name = (cur.name || '').slice(0, 12);
    const d1 = stats.r1 !== null ? Math.abs(stats.r1 - cur.r1) : null;
    const d3 = stats.r3 !== null ? Math.abs(stats.r3 - cur.r3) : null;
    const dd = Math.abs(stats.maxDD3y - (cur.maxDD3y || cur.maxDD || 0));
    if (d1 !== null && d1 > 5) r1Errors.push(code);
    if (d3 !== null && d3 > 10) r3Errors.push(code);
    if (dd > 5) ddErrors.push(code);

    console.log(`| ${code} | ${name} | ${cur.r1?.toFixed(1) ?? '—'} | ${stats.r1?.toFixed(1) ?? '—'} | ${d1?.toFixed(1) ?? '—'} | ${cur.r3?.toFixed(1) ?? '—'} | ${stats.r3?.toFixed(1) ?? '—'} | ${d3?.toFixed(1) ?? '—'} | ${(cur.maxDD3y ?? cur.maxDD ?? 0).toFixed(1)} | ${stats.maxDD3y.toFixed(1)} | ${dd.toFixed(1)} |`);
  });

  console.log(`\n═══ 结果 ═══`);
  console.log(`  r1 偏差 > 5%:  ${r1Errors.length}/${samples.length}`);
  console.log(`  r3 偏差 > 10%: ${r3Errors.length}/${samples.length}`);
  console.log(`  maxDD 偏差 > 5%: ${ddErrors.length}/${samples.length}`);

  if (r1Errors.length === 0 && r3Errors.length === 0 && ddErrors.length === 0) {
    console.log(`\n✓ 数据质量验证通过，SQLite 可作为方案 B 回测的数据底座。`);
  } else {
    console.log(`\n⚠️ 有偏差，需要进一步调查（可能来源：分红除权、拆分、数据源差异）`);
  }

  db.close();
}

if (require.main === module) main();
