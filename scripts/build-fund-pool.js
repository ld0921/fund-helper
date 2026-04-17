#!/usr/bin/env node
// 构建全市场 Top 500 基金池（按近 1 年涨幅）
// 来源：天天基金排名 API
// 输出：data/history-pool.json
//
// 池子按 5 个类别分配：股票/混合(active) 各 100，指数 100，债券 100，QDII 100
// 合计 500 只，应用基础筛选（规模 > 2 亿、成立 > 3 年、排除后端/C/E 份额）

const fs = require('fs');
const path = require('path');
const https = require('https');

const CATEGORIES = [
  { ft: 'gp',   cat: 'active', label: '股票型',    quota: 100 },
  { ft: 'hh',   cat: 'active', label: '混合型',    quota: 100 },
  { ft: 'zs',   cat: 'index',  label: '指数型',    quota: 100 },
  { ft: 'zq',   cat: 'bond',   label: '债券型',    quota: 100 },
  { ft: 'qdii', cat: 'qdii',   label: 'QDII',      quota: 100 },
];

// 固定保留（货币等特殊品种，排名不一定覆盖）
const FIXED_FUNDS = [
  { code: '003003', name: '华夏现金增利货币A', cat: 'money', label: '货币基金' },
  { code: '000198', name: '天治财富增长',       cat: 'active', label: '主动权益' },
  { code: '070009', name: '嘉实超短债债券A',    cat: 'bond',   label: '短债基金' },
];

function httpGet(url, headers, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('timeout')); });
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

function fetchRank(ft, pn) {
  // 近 1 年涨幅倒序
  const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=${pn}&dx=1`;
  return httpGetRetry(url, {
    'Referer': 'https://fund.eastmoney.com/data/fundranking.html',
    'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
  }).then(body => {
    const match = body.match(/var rankData\s*=\s*\{datas:\[(.*?)\],allRecords:(\d+)/s);
    if (!match) throw new Error(`parse failed for ft=${ft}`);
    const datas = JSON.parse(`[${match[1]}]`);
    return { datas, allRecords: parseInt(match[2]) || 0 };
  });
}

function parseFund(item, cat, label, type) {
  const f = item.split(',');
  if (f.length < 25) return null;
  const code = f[0];
  const name = f[1];
  const r1 = parseFloat(f[11]) || 0;
  const r3 = parseFloat(f[13]) || 0;
  const size = parseFloat(f[24]) || 0;
  const established = f[16] || '';
  const yearsOld = (Date.now() - new Date(established).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (yearsOld < 3) return null;           // 成立 < 3 年，历史数据不足
  if (size < 2) return null;               // 规模 < 2 亿，流动性差
  if (/后端|C$|E$|D$/.test(name)) return null; // 排除非主份额
  return { code, name, type, cat, label, r1, r3, size, established };
}

async function main() {
  console.log('═══ 构建全市场 Top 500 基金池 ═══');
  const allFunds = [];
  const codeSet = new Set();

  // 先加入固定基金
  FIXED_FUNDS.forEach(f => {
    if (!codeSet.has(f.code)) {
      allFunds.push({ ...f, type: f.label, r1: 0, r3: 0, size: 0, established: '', source: 'fixed' });
      codeSet.add(f.code);
    }
  });

  for (const c of CATEGORIES) {
    console.log(`\n[${c.label}] 拉取排名 pn=${c.quota * 2}（容错多拉一倍）`);
    const { datas, allRecords } = await fetchRank(c.ft, c.quota * 2);
    console.log(`  拿到 ${datas.length} 条，总记录 ${allRecords}`);
    let taken = 0;
    for (const item of datas) {
      if (taken >= c.quota) break;
      const f = parseFund(item, c.cat, c.label, c.label);
      if (!f) continue;
      if (codeSet.has(f.code)) continue;
      allFunds.push({ ...f, source: c.ft });
      codeSet.add(f.code);
      taken++;
    }
    console.log(`  实收 ${taken} 只通过筛选`);
    // 限速
    await new Promise(r => setTimeout(r, 500));
  }

  const out = {
    timestamp: new Date().toISOString(),
    totalCount: allFunds.length,
    byCategory: allFunds.reduce((s, f) => { s[f.cat] = (s[f.cat] || 0) + 1; return s; }, {}),
    funds: allFunds,
  };

  const outPath = path.resolve(__dirname, '../data/history-pool.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n✓ 基金池已写入 ${path.relative(path.resolve(__dirname, '..'), outPath)}`);
  console.log('  合计:', out.totalCount);
  console.log('  按类别:', JSON.stringify(out.byCategory));
}

if (require.main === module) {
  main().catch(e => { console.error('失败:', e.message); process.exit(1); });
}
