#!/usr/bin/env node
// 把 data/history-nav/raw/*.json 导入 SQLite（用 Node 22+ 内置 node:sqlite）
// 产物：data/history-nav.sqlite
//
// Schema:
//   funds(code TEXT PRIMARY KEY, name TEXT, cat TEXT, first_date TEXT, last_date TEXT, point_count INT, fetched_at TEXT)
//   nav_daily(code TEXT, ts INT, nav REAL, equity_return REAL, ac_nav REAL, PRIMARY KEY(code, ts))
//
// 用法: node scripts/import-nav-to-sqlite.js

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const RAW_DIR = path.resolve(__dirname, '../data/history-nav/raw');
const DB_PATH = path.resolve(__dirname, '../data/history-nav.sqlite');

function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error('❌ 先运行 scripts/fetch-history-nav.js');
    process.exit(1);
  }
  // 删掉旧 DB（简化，方便重跑）
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE funds (
      code TEXT PRIMARY KEY,
      name TEXT,
      cat TEXT,
      first_date TEXT,
      last_date TEXT,
      point_count INTEGER,
      fetched_at TEXT
    );
    CREATE TABLE nav_daily (
      code TEXT,
      ts INTEGER,
      nav REAL,
      equity_return REAL,
      ac_nav REAL,
      PRIMARY KEY (code, ts)
    );
    CREATE INDEX idx_nav_code_ts ON nav_daily(code, ts);
  `);

  const insFund = db.prepare('INSERT INTO funds (code, name, cat, first_date, last_date, point_count, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insNav = db.prepare('INSERT OR REPLACE INTO nav_daily (code, ts, nav, equity_return, ac_nav) VALUES (?, ?, ?, ?, ?)');

  const files = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  console.log(`═══ 导入 ${files.length} 只基金 ═══`);

  let totalPoints = 0;
  let successFunds = 0;
  let skipped = 0;

  db.exec('BEGIN');
  for (const file of files) {
    try {
      const fundData = JSON.parse(fs.readFileSync(path.join(RAW_DIR, file), 'utf8'));
      const code = fundData.code;
      const meta = fundData.meta || {};
      const trend = fundData.navTrend || [];
      const acNav = fundData.acNavTrend || [];
      if (trend.length === 0) { skipped++; continue; }

      // 建立 ts -> ac_nav 的映射（如果有）
      const acMap = new Map();
      acNav.forEach(p => { if (Array.isArray(p)) acMap.set(p[0], p[1]); });

      const firstDate = new Date(trend[0].x).toISOString().slice(0, 10);
      const lastDate = new Date(trend[trend.length - 1].x).toISOString().slice(0, 10);
      insFund.run(code, meta.name || '', meta.cat || '', firstDate, lastDate, trend.length, fundData.fetchedAt || '');

      for (const p of trend) {
        insNav.run(code, p.x, p.y, p.equityReturn !== undefined ? p.equityReturn : null, acMap.has(p.x) ? acMap.get(p.x) : null);
        totalPoints++;
      }
      successFunds++;
    } catch (e) {
      console.warn(`  ❌ ${file} 导入失败: ${e.message}`);
      skipped++;
    }
  }
  db.exec('COMMIT');

  db.exec('ANALYZE');
  const fileSize = fs.statSync(DB_PATH).size;
  console.log(`\n═══ 完成 ═══`);
  console.log(`  成功基金: ${successFunds}`);
  console.log(`  跳过基金: ${skipped}`);
  console.log(`  日净值点数: ${totalPoints.toLocaleString()}`);
  console.log(`  数据库大小: ${(fileSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  路径: ${path.relative(path.resolve(__dirname, '..'), DB_PATH)}`);

  // 快速验证
  const counts = db.prepare('SELECT cat, COUNT(*) as n FROM funds GROUP BY cat').all();
  console.log('\n  按类别分布:');
  counts.forEach(r => console.log(`    ${r.cat}: ${r.n}`));

  const sample = db.prepare('SELECT code, name, first_date, last_date, point_count FROM funds LIMIT 3').all();
  console.log('\n  样本:');
  sample.forEach(r => console.log(`    ${r.code} ${r.name} ${r.first_date}~${r.last_date} (${r.point_count} pts)`));

  db.close();
}

if (require.main === module) main();
