#!/usr/bin/env node
// 拉取全A股股票→行业分类映射表
// 来源：东方财富 push2 行情接口
// 输出：data/stock-industry-map.json
//
// 用途：基金重仓股 → 行业归因，识别主动基金的实际板块
// 更新频率：建议每月运行一次（行业归属变化较少）

const fs = require('fs');
const path = require('path');
const https = require('https');

function httpGet(url, headers, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
  });
}

async function httpGetRetry(url, headers, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try { return await httpGet(url, headers); }
    catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1)));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 沪深A股 fs 参数：主板+创业板+科创板+北交所
const FS_AH = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

async function fetchPage(pn, pz = 100) {
  // 使用 push2his 子域名（历史数据），比 push2 主域限流更宽松
  const url = `https://push2his.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${FS_AH}&fields=f12,f14,f100`;
  const body = await httpGetRetry(url, {
    'Referer': 'https://quote.eastmoney.com/',
    'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
  });
  const json = JSON.parse(body);
  return {
    total: (json.data && json.data.total) || 0,
    items: (json.data && json.data.diff) || []
  };
}

async function main() {
  console.log('═══ 拉取全A股股票→行业分类映射 ═══\n');

  // 先取第一页拿到总数
  const first = await fetchPage(1, 100);
  const total = first.total;
  const pages = Math.ceil(total / 100);
  console.log(`全A股总数: ${total}，共 ${pages} 页（每页100只）`);

  const stockMap = {};
  let added = 0;
  const failedPages = [];

  // 第一页数据
  first.items.forEach(s => {
    if (s.f12 && s.f100 && s.f100 !== '-') {
      stockMap[s.f12] = { name: s.f14 || '', industry: s.f100 };
      added++;
    }
  });
  console.log(`  第 1/${pages} 页: 已收录 ${added} 只`);

  // 后续页（增加间隔 + 失败重试队列）
  for (let pn = 2; pn <= pages; pn++) {
    try {
      const data = await fetchPage(pn, 100);
      data.items.forEach(s => {
        if (s.f12 && s.f100 && s.f100 !== '-') {
          stockMap[s.f12] = { name: s.f14 || '', industry: s.f100 };
          added++;
        }
      });
      if (pn % 10 === 0 || pn === pages) {
        console.log(`  第 ${pn}/${pages} 页: 累计收录 ${added} 只`);
      }
      await sleep(600);
    } catch (e) {
      failedPages.push(pn);
      console.warn(`  第 ${pn} 页失败，加入重试队列: ${e.message.substring(0, 50)}`);
      await sleep(2000); // 失败后多等2秒
    }
  }

  // 重试失败页（最多2轮）
  for (let round = 1; round <= 2; round++) {
    if (failedPages.length === 0) break;
    console.log(`\n第 ${round} 轮重试，剩余 ${failedPages.length} 页`);
    const retryList = [...failedPages];
    failedPages.length = 0;
    for (const pn of retryList) {
      try {
        await sleep(1500);
        const data = await fetchPage(pn, 100);
        data.items.forEach(s => {
          if (s.f12 && s.f100 && s.f100 !== '-') {
            stockMap[s.f12] = { name: s.f14 || '', industry: s.f100 };
            added++;
          }
        });
        console.log(`  第 ${pn} 页重试成功`);
      } catch (e) {
        failedPages.push(pn);
        console.warn(`  第 ${pn} 页仍失败`);
      }
    }
  }
  if (failedPages.length > 0) {
    console.warn(`\n⚠️ 最终仍有 ${failedPages.length} 页未拉取成功: ${failedPages.slice(0, 10).join(',')}${failedPages.length > 10 ? '...' : ''}`);
  }

  // 统计行业分布
  const industryStats = {};
  Object.values(stockMap).forEach(s => {
    industryStats[s.industry] = (industryStats[s.industry] || 0) + 1;
  });
  const sortedIndustries = Object.entries(industryStats).sort((a, b) => b[1] - a[1]);
  console.log(`\n行业分布（Top 20）:`);
  sortedIndustries.slice(0, 20).forEach(([ind, cnt]) => {
    console.log(`  ${ind}: ${cnt} 只`);
  });
  console.log(`  ... 共 ${sortedIndustries.length} 个行业`);

  // 输出
  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'stock-industry-map.json');

  const output = {
    timestamp: new Date().toISOString(),
    totalStocks: Object.keys(stockMap).length,
    totalIndustries: sortedIndustries.length,
    stocks: stockMap
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 0), 'utf-8');
  console.log(`\n✓ 映射表已写入 ${path.relative(path.resolve(__dirname, '..'), outPath)}`);
  console.log(`  共 ${Object.keys(stockMap).length} 只股票，${sortedIndustries.length} 个行业`);
}

if (require.main === module) {
  main().catch(e => { console.error('失败:', e.message); process.exit(1); });
}
