#!/usr/bin/env node
// 拉取天天基金排名数据 + 基金详情，生成 data/market-ranks.json
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

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: headers || {} }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ 排名数据 ═══
function fetchRank(ft, pn) {
  const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=${pn}&dx=1`;
  return httpGet(url, {
    'Referer': 'https://fund.eastmoney.com/data/fundranking.html',
    'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
  }).then(body => {
    const match = body.match(/var rankData\s*=\s*\{datas:\[(.*?)\],allRecords:(\d+)/s);
    if (!match) throw new Error(`parse failed for ft=${ft}`);
    const datas = JSON.parse(`[${match[1]}]`);
    return { datas, allRecords: parseInt(match[2]) || 0 };
  });
}

// 解析单条基金数据（25字段，索引0-24）
function parseFund(item, catInfo) {
  const f = item.split(',');
  if (f.length < 25) return null;
  const code = f[0];
  const name = f[1];
  const r1 = parseFloat(f[11]) || 0;
  const r3 = parseFloat(f[13]) || 0;
  const size = parseFloat(f[24]) || 0;
  const established = f[16] || '';
  const yearsOld = (Date.now() - new Date(established).getTime()) / (365.25*24*60*60*1000);
  if (yearsOld < 3 || size < 2) return null;
  if (/后端|C$|E$/.test(name)) return null;
  return { code, name, type: catInfo.type, cat: catInfo.cat, label: catInfo.label, r1, r3, size, established };
}

// ═══ 基金详情（pingzhongdata） ═══
async function fetchFundDetail(code) {
  try {
    const body = await httpGet(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      'Referer': 'https://fund.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
    });

    const result = {};

    // 近1年收益
    const r1Match = body.match(/var\s+syl_1n\s*=\s*"([^"]+)"/);
    if (r1Match) result.r1 = parseFloat(r1Match[1]) || 0;

    // 基金经理（JSON含嵌套数组，不能用非贪婪匹配，需要手动找完整的顶层[]）
    const mgrIdx = body.indexOf('var Data_currentFundManager =');
    if (mgrIdx >= 0) {
      const arrStart = body.indexOf('[', mgrIdx);
      if (arrStart >= 0) {
        let depth = 0, arrEnd = -1;
        for (let i = arrStart; i < body.length; i++) {
          if (body[i] === '[') depth++;
          else if (body[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
        }
        if (arrEnd > arrStart) {
          try {
            const mgrs = JSON.parse(body.substring(arrStart, arrEnd + 1));
            if (mgrs.length > 0) {
              result.manager = mgrs[0].name || '';
              const wt = mgrs[0].workTime || '';
              const ym = wt.match(/(\d+)年/);
              const dm = wt.match(/(\d+)天/);
              result.mgrYears = Math.round(((ym ? parseInt(ym[1]) : 0) + (dm ? parseInt(dm[1]) / 365 : 0)) * 10) / 10;
              result.star = mgrs[0].star || 3;
            }
          } catch (e) {}
        }
      }
    }

    // 历史净值 → 最大回撤
    const navMatch = body.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (navMatch) {
      try {
        const navData = JSON.parse(navMatch[1]);
        if (navData.length >= 10) {
          let peak = 0, maxDD = 0;
          navData.forEach(p => {
            const v = p.y || 0;
            if (v > peak) peak = v;
            if (peak > 0) {
              const dd = (peak - v) / peak * 100;
              if (dd > maxDD) maxDD = dd;
            }
          });
          result.maxDD = Math.round(maxDD * 10) / 10;
        }
      } catch (e) {}
    }

    // 规模（JSON含嵌套，手动匹配完整{}）
    const scaleIdx = body.indexOf('var Data_fluctuationScale =');
    if (scaleIdx >= 0) {
      const objStart = body.indexOf('{', scaleIdx);
      if (objStart >= 0) {
        let depth = 0, objEnd = -1;
        for (let i = objStart; i < body.length; i++) {
          if (body[i] === '{') depth++;
          else if (body[i] === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
        }
        if (objEnd > objStart) {
          try {
            const scaleData = JSON.parse(body.substring(objStart, objEnd + 1));
            if (scaleData.series && scaleData.series.length > 0) {
              result.fundSize = scaleData.series[scaleData.series.length - 1].y || 0;
            }
          } catch (e) {}
        }
      }
    }

    return result;
  } catch (e) {
    console.warn(`    详情获取失败 ${code}: ${e.message}`);
    return null;
  }
}

// 根据maxDD推断风险等级
function inferRiskLevel(maxDD, cat) {
  if (cat === 'money') return 'R1';
  if (cat === 'bond') return maxDD > 5 ? 'R3' : maxDD > 2 ? 'R2' : 'R1';
  if (maxDD >= 45) return 'R5';
  if (maxDD >= 30) return 'R4';
  if (maxDD >= 15) return 'R3';
  if (maxDD >= 5) return 'R2';
  return 'R1';
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

      // 为每只基金补充详情（maxDD、经理、任期、星级）
      console.log(`    补充 ${funds.length} 只基金详情…`);
      for (let i = 0; i < funds.length; i++) {
        const f = funds[i];
        const detail = await fetchFundDetail(f.code);
        if (detail) {
          if (detail.maxDD > 0 && detail.maxDD <= 100) f.maxDD = detail.maxDD;
          if (detail.manager) f.manager = detail.manager;
          if (detail.mgrYears > 0) f.mgrYears = detail.mgrYears;
          if (detail.star >= 1 && detail.star <= 5) f.stars = detail.star;
          if (detail.fundSize > 0) f.size = Math.round(detail.fundSize * 100) / 100;
          if (detail.r1 !== undefined && isFinite(detail.r1)) f.r1 = detail.r1;
          f.risk = inferRiskLevel(f.maxDD || 0, f.cat);
        }
        // 间隔300ms避免请求过快
        if (i < funds.length - 1) await sleep(300);
      }

      result.categories[catInfo.ft] = {
        label: catInfo.label,
        cat: catInfo.cat,
        type: catInfo.type,
        allRecords: data.allRecords,
        funds
      };
      totalFunds += funds.length;
      const withDetail = funds.filter(f => f.maxDD > 0).length;
      console.log(`    ✓ 获取 ${funds.length} 只，${withDetail} 只含完整详情（总市场 ${data.allRecords} 只）`);
    } catch (e) {
      console.error(`    ✗ ${catInfo.label} 失败:`, e.message);
      result.categories[catInfo.ft] = { label: catInfo.label, cat: catInfo.cat, type: catInfo.type, allRecords: 0, funds: [] };
    }
  }

  // 确保输出目录存在
  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'market-ranks.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n完成！共 ${totalFunds} 只基金，已写入 ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
