#!/usr/bin/env node
// 拉取 feeder-etf-map.json 中所有ETF本体的前10大重仓股
// 用法: node scripts/fetch-etf-holdings.js
// 输出: data/etf-holdings.json  {"510300": [{code, name, pct}, ...], ...}

const fs   = require('fs');
const path = require('path');
const https = require('https');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'Referer': 'https://fundf10.eastmoney.com/', 'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTopStocks(code) {
  const body = await httpGet(
    `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`
  );
  const re = /<tr><td>\d+<\/td><td><a[^>]*>(\d{6})<\/a><\/td><td[^>]*><a[^>]*>([^<]+)<\/a><\/td>[\s\S]*?<td class='tor'>([\d.]+)%<\/td>/g;
  const stocks = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    stocks.push({ code: m[1], name: m[2], pct: parseFloat(m[3]) });
  }
  return stocks;
}

async function main() {
  const mapPath = path.join(__dirname, '..', 'data', 'feeder-etf-map.json');
  const outPath = path.join(__dirname, '..', 'data', 'etf-holdings.json');

  const feederMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  const etfCodes  = [...new Set(Object.values(feederMap))];

  console.log(`共 ${etfCodes.length} 只ETF，开始拉取持仓...`);
  const result = {};
  for (const code of etfCodes) {
    try {
      const stocks = await fetchTopStocks(code);
      if (stocks.length > 0) {
        result[code] = stocks;
        console.log(`  ✓ ${code}: ${stocks.slice(0, 3).map(s => `${s.name}(${s.pct}%)`).join(' ')}`);
      } else {
        console.log(`  - ${code}: 无数据`);
      }
    } catch (e) {
      console.warn(`  ✗ ${code}: ${e.message}`);
    }
    await sleep(300);
  }

  fs.writeFileSync(outPath, JSON.stringify({
    updated: new Date().toISOString().slice(0, 10),
    stocks: result,
  }, null, 2), 'utf-8');
  console.log(`\n完成: ${Object.keys(result).length}/${etfCodes.length} 只ETF → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
