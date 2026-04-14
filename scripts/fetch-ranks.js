#!/usr/bin/env node
// 拉取天天基金排名数据 + 基金详情，生成 data/market-ranks.json
// 用法: node scripts/fetch-ranks.js

const fs = require('fs');
const path = require('path');
const https = require('https');

// 固定保留的基金代码（货币/超短债等特殊品种，全市场扫描不覆盖）
const FIXED_CODES = ['000198','003003','070009'];

const CATEGORIES = [
  { ft: 'gp',   cat: 'active', label: '股票型', type: '股票型' },
  { ft: 'hh',   cat: 'active', label: '混合型', type: '混合型' },
  { ft: 'zs',   cat: 'index',  label: '指数型', type: '指数型' },
  { ft: 'zq',   cat: 'bond',   label: '债券型', type: '债券型' },
  { ft: 'qdii', cat: 'qdii',   label: 'QDII',   type: 'QDII' },
];

function httpGet(url, headers, timeout) {
  timeout = timeout || 15000;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || {} }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error(`请求超时 ${timeout}ms: ${url}`)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 带指数退避的重试包装
async function httpGetWithRetry(url, headers, timeout, retries) {
  retries = retries || 3;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGet(url, headers, timeout);
    } catch (e) {
      if (attempt >= retries) throw e;
      const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.warn(`    请求失败(第${attempt}次)，${delay}ms后重试: ${e.message}`);
      await sleep(delay);
    }
  }
}

// ═══ 排名数据 ═══
function fetchRank(ft, pn) {
  const url = `https://fund.eastmoney.com/data/rankhandler.aspx?op=ph&dt=kf&ft=${ft}&rs=&gs=0&sc=1nzf&st=desc&pi=1&pn=${pn}&dx=1`;
  return httpGetWithRetry(url, {
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
    const body = await httpGetWithRetry(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, {
      'Referer': 'https://fund.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
    });

    const result = {};

    // 近1年收益
    const r1Match = body.match(/var\s+syl_1n\s*=\s*"([^"]+)"/);
    if (r1Match) result.r1 = parseFloat(r1Match[1]) || 0;

    // 申购费率（支付宝等平台1折后费率）
    const feeMatch = body.match(/var\s+fund_Rate\s*=\s*"([^"]+)"/);
    if (feeMatch) {
      const feeVal = parseFloat(feeMatch[1]);
      if (isFinite(feeVal) && feeVal >= 0 && feeVal <= 5) result.fee = feeVal;
    }

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

    // 历史净值 → 最大回撤（全期 + 近3年）
    const navMatch = body.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (navMatch) {
      try {
        const navData = JSON.parse(navMatch[1]);
        if (navData.length >= 10) {
          // 全期最大回撤
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

          // 近36个月月度收益率（用于类别相关性矩阵计算）
          const threeYearsAgo = Date.now() - 3 * 365.25 * 24 * 60 * 60 * 1000;
          const nav3y = navData.filter(p => p.x >= threeYearsAgo);
          if (nav3y.length >= 2) {
            // 按月采样：取每月最后一个净值点
            const byMonth = {};
            nav3y.forEach(p => {
              const d = new Date(p.x);
              const key = `${d.getFullYear()}-${d.getMonth()}`;
              byMonth[key] = p.y;
            });
            const monthlyVals = Object.keys(byMonth).sort().map(k => byMonth[k]);
            const monthlyReturns = [];
            for (let i = 1; i < monthlyVals.length; i++) {
              if (monthlyVals[i - 1] > 0) {
                monthlyReturns.push(Math.round((monthlyVals[i] / monthlyVals[i - 1] - 1) * 10000) / 100);
              }
            }
            if (monthlyReturns.length >= 6) result.monthlyReturns = monthlyReturns;
          }

          // 近3年最大回撤（与r3时间窗口匹配）
          if (nav3y.length >= 10) {
            let peak3 = 0, maxDD3 = 0;
            nav3y.forEach(p => {
              const v = p.y || 0;
              if (v > peak3) peak3 = v;
              if (peak3 > 0) {
                const dd = (peak3 - v) / peak3 * 100;
                if (dd > maxDD3) maxDD3 = dd;
              }
            });
            result.maxDD3y = Math.round(maxDD3 * 10) / 10;
          }
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

// 拉取近3年收益率（FundArchivesDatas页面）
async function fetchFundR3(code) {
  try {
    const body = await httpGetWithRetry(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jdzf&code=${code}`, {
      'Referer': 'https://fundf10.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
    });
    // 匹配"近3年"行后第一个百分比数字
    const match = body.match(/近3年[\s\S]*?<li[^>]*>([-\d.]+)%/);
    if (match) return parseFloat(match[1]) || null;
    return null;
  } catch (e) {
    console.warn(`    R3获取失败 ${code}: ${e.message}`);
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

// 根据基金数据自动生成标签
function autoTags(f) {
  const tags = [];
  const cat = f.cat || '';
  const name = f.name || '';
  if (cat === 'money') return ['货币', '流动性', '现金管理'];
  if (cat === 'bond') {
    if (f.maxDD && f.maxDD < 3) tags.push('超短债');
    else tags.push('债券');
    tags.push('稳健');
    return tags;
  }
  if (cat === 'qdii') {
    if (/纳斯达克|纳指/.test(name)) tags.push('纳斯达克', '美股', '科技');
    else if (/标普|S&P/.test(name)) tags.push('标普500', '美股', '全球配置');
    else if (/互联|中概/.test(name)) tags.push('互联网', '港股', '科技');
    else tags.push('海外', 'QDII', '全球配置');
    return tags;
  }
  // 指数/主动
  if (/沪深300|300/.test(name)) tags.push('沪深300', '宽基', '蓝筹');
  else if (/中证500|500/.test(name)) tags.push('中证500', '中盘', '成长');
  else if (/创业板/.test(name)) tags.push('创业板', '科技', '成长');
  else if (/红利|股息/.test(name)) tags.push('高股息', '红利', '防御');
  else if (/医疗|医药|健康/.test(name)) tags.push('医疗', '医药', '行业');
  else if (/科技|信息|半导体/.test(name)) tags.push('科技', '成长', '行业');
  else if (/消费/.test(name)) tags.push('消费', '成长', '价值');
  else tags.push(cat === 'index' ? '指数' : '主动权益', '均衡');
  return tags;
}

// 根据基金数据自动生成推荐理由
function autoReason(f) {
  const r1Str = f.r1 !== undefined ? `近1年收益 ${f.r1 > 0 ? '+' : ''}${f.r1}%` : '';
  const r3Str = f.r3 !== undefined ? `近3年 ${f.r3 > 0 ? '+' : ''}${f.r3}%` : '';
  const mgrStr = f.mgrYears > 0 ? `基金经理${f.manager || ''}任职 ${f.mgrYears} 年` : '';
  const ddStr = f.maxDD > 0 ? `历史最大回撤 ${f.maxDD}%` : '';
  const parts = [r1Str, r3Str, mgrStr, ddStr].filter(Boolean);
  return parts.join('，') + '。由全市场扫描自动入选。';
}

async function main() {
  console.log('开始拉取全市场基金排名数据…');
  const result = { timestamp: new Date().toISOString(), categories: {} };
  let totalFunds = 0;
  // 存储每类别的全量解析数据（Top50/100），用于计算市场基准
  const allParsedByCat = {};

  for (const catInfo of CATEGORIES) {
    try {
      console.log(`  拉取 ${catInfo.label} Top ${catInfo.ft === 'zs' ? 100 : 50}…`);
      const pn = catInfo.ft === 'zs' ? 100 : 50; // 指数基金拉取更多，弥补筛选后数量不足
      const data = await fetchRank(catInfo.ft, pn);
      const allParsed = data.datas.map(item => parseFund(item, catInfo)).filter(Boolean);

      // 为每只基金补充详情（maxDD、经理、任期、星级）
      console.log(`    补充 ${allParsed.length} 只基金详情…`);
      for (let i = 0; i < allParsed.length; i++) {
        const f = allParsed[i];
        const detail = await fetchFundDetail(f.code);
        if (detail) {
          if (detail.maxDD > 0 && detail.maxDD <= 100) f.maxDD = detail.maxDD;
          if (detail.maxDD3y > 0 && detail.maxDD3y <= 100) f.maxDD3y = detail.maxDD3y;
          if (detail.manager) f.manager = detail.manager;
          if (detail.mgrYears > 0) f.mgrYears = detail.mgrYears;
          if (detail.star >= 1 && detail.star <= 5) f.stars = detail.star;
          if (detail.fundSize > 0) f.size = Math.round(detail.fundSize * 100) / 100;
          if (detail.r1 !== undefined && isFinite(detail.r1)) f.r1 = detail.r1;
          if (detail.fee !== undefined) f.fee = detail.fee;
          if (detail.monthlyReturns) f.monthlyReturns = detail.monthlyReturns;
          f.risk = inferRiskLevel(f.maxDD || 0, f.cat);
        }
        // 间隔300ms避免请求过快
        if (i < allParsed.length - 1) await sleep(300);
      }

      // 保存全量解析数据用于市场基准计算（在多维筛选之前）
      if (!allParsedByCat[catInfo.cat]) allParsedByCat[catInfo.cat] = [];
      allParsedByCat[catInfo.cat].push(...allParsed.filter(f => f.maxDD > 0));

      // 多维排序取并集，扩大候选池
      const withDetail = allParsed.filter(f => f.maxDD > 0);
      const selectedCodes = new Set();

      // 维度1: 近1年收益 Top 10
      [...withDetail].sort((a, b) => b.r1 - a.r1).slice(0, 10).forEach(f => selectedCodes.add(f.code));

      // 维度2: Calmar Ratio Top 10 (r1/maxDD3y，时间窗口匹配)
      [...withDetail].filter(f => (f.maxDD3y || f.maxDD) > 0).sort((a, b) => {
        const calA = a.r1 / (a.maxDD3y || a.maxDD);
        const calB = b.r1 / (b.maxDD3y || b.maxDD);
        return calB - calA;
      }).slice(0, 10).forEach(f => selectedCodes.add(f.code));

      // 维度3: 近3年收益 Top 10
      [...withDetail].filter(f => f.r3 > 0).sort((a, b) => b.r3 - a.r3).slice(0, 10).forEach(f => selectedCodes.add(f.code));

      // 合并去重，最终每类别最多保留（指数25只，其他20只）
      const maxPerCat = catInfo.ft === 'zs' ? 25 : 20;
      const funds = allParsed.filter(f => selectedCodes.has(f.code)).slice(0, maxPerCat);

      result.categories[catInfo.ft] = {
        label: catInfo.label,
        cat: catInfo.cat,
        type: catInfo.type,
        allRecords: data.allRecords,
        funds
      };
      totalFunds += funds.length;
      const withDetailCount = funds.filter(f => f.maxDD > 0).length;
      console.log(`    ✓ 获取 ${funds.length} 只（多维排序去重），${withDetailCount} 只含完整详情（总市场 ${data.allRecords} 只）`);
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

  // ═══ 从全市场Top50/100原始数据提取市场基准统计 ═══
  // 使用 allParsedByCat（筛选前的全量数据），而非精选后的 result.categories
  // 这样基准覆盖 ~40-80 只/类别，比精选库的 ~15-20 只更广谱
  const finalBenchmarks = {};
  for (const cat of Object.keys(allParsedByCat)) {
    const funds = allParsedByCat[cat];
    const r1s = funds.map(f => f.r1).filter(v => isFinite(v));
    if (r1s.length < 3) continue;
    const avgR1 = r1s.reduce((s, v) => s + v, 0) / r1s.length;
    const stdR1 = r1s.length > 1 ? Math.sqrt(r1s.reduce((s, v) => s + (v - avgR1) ** 2, 0) / r1s.length) || 1 : 1;
    const dds = funds.map(f => f.maxDD).filter(v => v > 0);
    const avgDD = dds.length > 0 ? dds.reduce((s, v) => s + v, 0) / dds.length : 0;
    const r3s = funds.map(f => f.r3).filter(v => isFinite(v));
    const avgR3 = r3s.length > 0 ? r3s.reduce((s, v) => s + v, 0) / r3s.length : 0;
    // 月度收益序列：取各基金序列的逐月均值（用于前端动态计算相关性矩阵）
    const allMonthly = funds.map(f => f.monthlyReturns).filter(a => a && a.length >= 6);
    let monthlyReturns = [];
    if (allMonthly.length > 0) {
      const minLen = Math.min(...allMonthly.map(a => a.length));
      for (let i = 0; i < minLen; i++) {
        const avg = allMonthly.reduce((s, a) => s + a[i], 0) / allMonthly.length;
        monthlyReturns.push(Math.round(avg * 100) / 100);
      }
    }
    finalBenchmarks[cat] = {
      avgR1: Math.round(avgR1 * 100) / 100,
      stdR1: Math.round(stdR1 * 100) / 100,
      avgDD: Math.round(avgDD * 100) / 100,
      avgR3: Math.round(avgR3 * 100) / 100,
      count: r1s.length,
      ...(monthlyReturns.length >= 6 && { monthlyReturns })
    };
  }
  console.log('\n市场基准统计（基于全市场Top扫描，筛选前全量数据）:');
  for (const cat of Object.keys(finalBenchmarks)) {
    const b = finalBenchmarks[cat];
    console.log(`  ${cat}: avgR1=${b.avgR1}% stdR1=${b.stdR1}% avgDD=${b.avgDD}% count=${b.count}`);
  }

  // ═══ 从全市场扫描结果构建动态精选库 ═══
  // 收集所有类别的候选基金（已含详情），合并去重
  const dynamicCodes = new Set(FIXED_CODES);
  for (const catKey of Object.keys(result.categories)) {
    const catFunds = result.categories[catKey].funds || [];
    catFunds.forEach(f => dynamicCodes.add(f.code));
  }
  // 构建 code→fund 快速查找表（来自全市场扫描）
  const scannedMap = {};
  for (const catKey of Object.keys(result.categories)) {
    (result.categories[catKey].funds || []).forEach(f => { scannedMap[f.code] = f; });
  }

  console.log(`\n开始构建动态精选库（${dynamicCodes.size} 只候选基金）…`);
  const curatedResult = { timestamp: new Date().toISOString(), marketBenchmarks: finalBenchmarks, funds: {} };
  let curatedDone = 0;

  for (const code of dynamicCodes) {
    try {
      // 已有扫描数据的基金直接复用，只补充 r3（扫描阶段未拉取）
      const base = scannedMap[code];
      let detail = null;
      let r3 = null;

      if (base && base.maxDD > 0) {
        // 已有完整详情，只补 r3
        r3 = await fetchFundR3(code);
        detail = { r1: base.r1, maxDD: base.maxDD, maxDD3y: base.maxDD3y,
          manager: base.manager, mgrYears: base.mgrYears, star: base.stars, fundSize: base.size,
          fee: base.fee };
      } else {
        // 固定基金（货币/超短债）需单独拉取
        detail = await fetchFundDetail(code);
        r3 = await fetchFundR3(code);
      }

      if (detail) {
        const f = base || {};
        const entry = {
          name: f.name || '',
          type: f.type || '',
          cat: f.cat || '',
          label: f.label || '',
          risk: f.risk || '',
        };
        if (detail.r1 !== undefined && isFinite(detail.r1)) entry.r1 = detail.r1;
        if (r3 !== null) entry.r3 = r3;
        if (detail.maxDD > 0 && detail.maxDD <= 100) entry.maxDD = detail.maxDD;
        if (detail.maxDD3y > 0 && detail.maxDD3y <= 100) entry.maxDD3y = detail.maxDD3y;
        if (detail.manager) entry.manager = detail.manager;
        if (detail.mgrYears > 0) entry.mgrYears = detail.mgrYears;
        if (detail.star >= 1 && detail.star <= 5) entry.stars = detail.star;
        if (detail.fundSize > 0) entry.size = Math.round(detail.fundSize * 100) / 100;
        if (detail.fee !== undefined) entry.fee = detail.fee;

        // 自动生成 reason 和 tags
        entry.tags = autoTags(entry);
        entry.reason = autoReason(entry);

        curatedResult.funds[code] = entry;
        curatedDone++;
      }
    } catch (e) {
      console.warn(`    精选库详情失败 ${code}: ${e.message}`);
    }
    await sleep(150);
  }

  const curatedPath = path.join(outDir, 'curated-details.json');
  fs.writeFileSync(curatedPath, JSON.stringify(curatedResult, null, 2), 'utf-8');
  console.log(`精选库详情完成！${curatedDone}/${dynamicCodes.size} 只成功，已写入 ${curatedPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
