#!/usr/bin/env node
// 拉取天天基金排名数据，生成 data/market-ranks.json
// 用法: node scripts/fetch-ranks.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const CATEGORIES = [
  { ft: 'gp',   cat: 'active', label: '股票型', type: '股票型' },
  { ft: 'hh',   cat: 'active', label: '混合型', type: '混合型' },
  { ft: 'zs',   cat: 'index',  label: '指数型', type: '指数型' },
  { ft: 'zq',   cat: 'bond',   label: '债券型', type: '债券型' },
  { ft: 'qdii', cat: 'qdii',   label: 'QDII',   type: 'QDII' },
];

function fetchRank(ft, pn) {
  const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=${pn}&dx=1`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: {
      'Referer': 'https://fund.eastmoney.com/data/fundranking.html',
      'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
    }}, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const match = body.match(/var rankData\s*=\s*\{datas:\[(.*?)\],allRecords:(\d+)/s);
        if (!match) { reject(new Error(`parse failed for ft=${ft}`)); return; }
        try {
          const datas = JSON.parse(`[${match[1]}]`);
          resolve({ datas, allRecords: parseInt(match[2]) || 0 });
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// 解析单条基金数据（25字段，索引0-24）
// 0:code 1:name 2:pinyin 3:净值日期 4:dwjz 5:ljjz 6:日涨跌 7:近1周 8:近1月
// 9:近3月 10:近6月 11:近1年 12:近2年 13:近3年 14:近5年 15:成立以来
// 16:成立日期 17:类型标记 18:累计净值精确 19:申购费 20:折后费 21:可购 22:折后费2 23:? 24:规模(亿)
function parseFund(item, catInfo) {
  const f = item.split(',');
  if (f.length < 25) return null;
  const code = f[0];
  const name = f[1];
  const r1 = parseFloat(f[11]) || 0;
  const r3 = parseFloat(f[13]) || 0;
  const size = parseFloat(f[24]) || 0;
  const established = f[16] || '';
  // 过滤：成立<3年、规模<2亿、C/E类份额
  const yearsOld = (Date.now() - new Date(established).getTime()) / (365.25*24*60*60*1000);
  if (yearsOld < 3 || size < 2) return null;
  if (/后端|C$|E$/.test(name)) return null;
  return { code, name, type: catInfo.type, cat: catInfo.cat, label: catInfo.label, r1, r3, size, established };
}

async function main() {
  console.log('开始拉取全市场基金排名数据…');
  const result = { timestamp: new Date().toISOString(), categories: {} };
  let totalFunds = 0;

  for (const catInfo of CATEGORIES) {
    try {
      console.log(`  拉取 ${catInfo.label} Top 30（过滤C/E类后取前10）…`);
      const data = await fetchRank(catInfo.ft, 30);
      const funds = data.datas.map(item => parseFund(item, catInfo)).filter(Boolean).slice(0, 10);
      result.categories[catInfo.ft] = {
        label: catInfo.label,
        cat: catInfo.cat,
        type: catInfo.type,
        allRecords: data.allRecords,
        funds
      };
      totalFunds += funds.length;
      console.log(`    ✓ 获取 ${funds.length} 只（总市场 ${data.allRecords} 只）`);
    } catch (e) {
      console.error(`    ✗ ${catInfo.label} 失败:`, e.message);
      result.categories[catInfo.ft] = { label: catInfo.label, cat: catInfo.cat, type: catInfo.type, allRecords: 0, funds: [] };
    }
  }

  const outPath = path.join(__dirname, '..', 'data', 'market-ranks.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n完成！共 ${totalFunds} 只基金，已写入 ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
