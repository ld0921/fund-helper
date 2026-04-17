#!/usr/bin/env node
// 拉取 history-pool.json 中每只基金的 5 年日净值
// 来源：天天基金 pingzhongdata 接口（JSONP，一次返回完整历史）
// 存储：data/history-nav/raw/${code}.json（每基金一文件，便于增量和容错）
//
// 用法:
//   node scripts/fetch-history-nav.js              # 全量，跳过已存在的
//   node scripts/fetch-history-nav.js --force      # 强制重拉所有
//   node scripts/fetch-history-nav.js --rate=1000  # 自定义限速 ms（默认 500 = 2 req/s）
//   node scripts/fetch-history-nav.js --limit=10   # 仅拉前 N 只（测试用）

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const rateArg = args.find(a => a.startsWith('--rate='));
const RATE_MS = rateArg ? parseInt(rateArg.split('=')[1]) : 500; // 默认 2 req/s
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : Infinity;

const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

function httpGet(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Referer': 'https://fund.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)',
      }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
  });
}

async function httpGetRetry(url, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try { return await httpGet(url); }
    catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 从 pingzhongdata 响应里提取 Data_netWorthTrend 数组
function extractNavTrend(body) {
  const match = body.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (e) { return null; }
}

// 同时提取 Data_ACWorthTrend（累计净值，债券/货币更稳健）
function extractACNav(body) {
  const match = body.match(/var\s+Data_ACWorthTrend\s*=\s*(\[\[[\s\S]*?\]\]);/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (e) { return null; }
}

async function fetchFundHistory(code) {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
  const body = await httpGetRetry(url);
  const trend = extractNavTrend(body);
  const acNav = extractACNav(body);
  if (!trend || trend.length === 0) {
    throw new Error(`no nav data for ${code}`);
  }
  // 过滤到近 5 年
  const cutoff = Date.now() - FIVE_YEARS_MS;
  const filtered = trend.filter(p => p.x >= cutoff);
  // AC 净值格式是 [[timestamp, value], ...]
  const acFiltered = acNav ? acNav.filter(p => Array.isArray(p) && p[0] >= cutoff) : null;
  return {
    code,
    fetchedAt: new Date().toISOString(),
    count: filtered.length,
    navTrend: filtered,    // {x: ms, y: 单位净值, equityReturn: 单日涨跌%}
    acNavTrend: acFiltered, // [[ms, 累计净值]]
  };
}

async function main() {
  const poolPath = path.resolve(__dirname, '../data/history-pool.json');
  if (!fs.existsSync(poolPath)) {
    console.error('❌ 先运行 scripts/build-fund-pool.js 生成 history-pool.json');
    process.exit(1);
  }
  const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
  const funds = pool.funds.slice(0, LIMIT);
  const rawDir = path.resolve(__dirname, '../data/history-nav/raw');
  fs.mkdirSync(rawDir, { recursive: true });

  const startTime = Date.now();
  console.log(`═══ 拉取 ${funds.length} 只基金 × 5 年日净值 ═══`);
  console.log(`  限速 ${RATE_MS}ms/req (${(1000/RATE_MS).toFixed(1)} req/s)`);
  console.log(`  预计用时: ${Math.ceil(funds.length * RATE_MS / 1000 / 60)} 分钟\n`);

  const results = { success: 0, skipped: 0, failed: [] };

  for (let i = 0; i < funds.length; i++) {
    const f = funds[i];
    const outPath = path.join(rawDir, `${f.code}.json`);

    // 增量：已存在且不 force 则跳过
    if (!FORCE && fs.existsSync(outPath)) {
      const stat = fs.statSync(outPath);
      // 文件小于 24 小时认为是最新
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        results.skipped++;
        continue;
      }
    }

    const progress = `[${i + 1}/${funds.length}]`;
    try {
      const data = await fetchFundHistory(f.code);
      data.meta = { name: f.name, cat: f.cat, label: f.label };
      fs.writeFileSync(outPath, JSON.stringify(data));
      const firstDate = data.navTrend.length > 0 ? new Date(data.navTrend[0].x).toISOString().slice(0, 10) : '?';
      const lastDate = data.navTrend.length > 0 ? new Date(data.navTrend[data.navTrend.length - 1].x).toISOString().slice(0, 10) : '?';
      if (i % 10 === 0 || i === funds.length - 1) {
        const elapsed = (Date.now() - startTime) / 1000;
        const eta = ((funds.length - i - 1) * RATE_MS / 1000).toFixed(0);
        console.log(`  ${progress} ${f.code} ${f.name.slice(0, 20).padEnd(20)} ${firstDate}~${lastDate} (${data.count} pts) · 已用 ${elapsed.toFixed(0)}s · ETA ${eta}s`);
      }
      results.success++;
    } catch (e) {
      console.warn(`  ${progress} ${f.code} ${f.name.slice(0, 20)} 失败: ${e.message}`);
      results.failed.push({ code: f.code, name: f.name, error: e.message });
    }

    // 限速
    if (i < funds.length - 1) await sleep(RATE_MS);
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n═══ 完成 ═══`);
  console.log(`  成功: ${results.success}`);
  console.log(`  跳过(增量): ${results.skipped}`);
  console.log(`  失败: ${results.failed.length}`);
  console.log(`  总耗时: ${(elapsed / 60).toFixed(1)} 分钟`);

  // 写入汇总
  const summaryPath = path.resolve(__dirname, '../data/history-nav/fetch-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    elapsedSec: elapsed,
    poolTotal: funds.length,
    ...results,
  }, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('致命错误:', e); process.exit(1); });
}
