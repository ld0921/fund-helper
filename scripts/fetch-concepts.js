#!/usr/bin/env node
// 爬取东财概念板块 → 股票映射，生成 data/stock-concept-map.json
// 用法: node scripts/fetch-concepts.js

const fs   = require('fs');
const path = require('path');
const https = require('https');

// 目标概念关键词：只抓对基金板块归类有意义的投资主题
const TARGET_CONCEPTS = [
  'CPO', '光模块', '存储芯片', 'HBM', '算力', '人工智能',
  '光伏', '储能', '新能源车', '半导体', '消费电子',
  '创新药', 'CXO', '医疗器械', '黄金', '军工',
];

// 概念名称标准化（去掉"概念"/"指数"后缀，保持 UI 简洁）
function normalize(name) {
  return name.replace(/概念$/, '').replace(/指数$/, '').trim();
}

const EM_HEADERS = {
  'Referer': 'https://www.eastmoney.com/',
  'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)',
};

function httpGet(url, timeout) {
  timeout = timeout || 15000;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: EM_HEADERS }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`超时: ${url}`)));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGetWithRetry(url, retries) {
  retries = retries || 3;
  for (let i = 1; i <= retries; i++) {
    try { return await httpGet(url); }
    catch (e) {
      if (i >= retries) throw e;
      await sleep(1000 * Math.pow(2, i - 1));
    }
  }
}

async function fetchConceptList() {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get' +
    '?pn=1&pz=2000&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281' +
    '&fltt=2&invt=2&fid=f20&fs=m:90+t:3&fields=f12,f14';
  const body = await httpGetWithRetry(url);
  const data = JSON.parse(body);
  return (data.data?.diff || []).map(d => ({ code: d.f12, name: String(d.f14) }));
}

async function fetchConceptStocks(bkCode) {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get' +
    `?pn=1&pz=500&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281` +
    `&fltt=2&invt=2&fid=f3&fs=b:${bkCode}&fields=f12`;
  const body = await httpGetWithRetry(url);
  const data = JSON.parse(body);
  return (data.data?.diff || []).map(d => String(d.f12).padStart(6, '0'));
}

async function main() {
  const outPath = path.join(__dirname, '..', 'data', 'stock-concept-map.json');

  console.log('Step 1: 获取概念板块列表...');
  const allConcepts = await fetchConceptList();
  console.log(`  共 ${allConcepts.length} 个概念板块`);

  const matched = allConcepts.filter(c =>
    TARGET_CONCEPTS.some(kw => c.name.includes(kw))
  );
  console.log(`  命中目标关键词：${matched.length} 个`);
  matched.forEach(c => console.log(`    ${c.code}  ${c.name}`));

  console.log('\nStep 2: 拉取各板块成分股...');
  const stockMap = {};
  for (const concept of matched) {
    try {
      const stocks = await fetchConceptStocks(concept.code);
      const label = normalize(concept.name);
      stocks.forEach(code => {
        if (!stockMap[code]) stockMap[code] = [];
        if (!stockMap[code].includes(label)) stockMap[code].push(label);
      });
      console.log(`  ${concept.name} → ${stocks.length} 只`);
    } catch (e) {
      console.warn(`  ⚠️  ${concept.name} 失败: ${e.message}`);
    }
    await sleep(300);
  }

  fs.writeFileSync(outPath, JSON.stringify({
    updated: new Date().toISOString().slice(0, 10),
    conceptCount: matched.length,
    stocks: stockMap,
  }, null, 2), 'utf-8');

  console.log(`\n完成: ${Object.keys(stockMap).length} 只股票有概念标签 → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
