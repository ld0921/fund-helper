#!/usr/bin/env node
// 拉取天天基金排名数据 + 基金详情，生成 data/market-ranks.json
// 用法: node scripts/fetch-ranks.js

const fs = require('fs');
const path = require('path');
const https = require('https');

// 固定保留的基金代码（货币/超短债等特殊品种，全市场扫描不覆盖）
const FIXED_CODES = ['000198','003003','070009'];
// 固定基金的预设元数据（扫描不覆盖，需手动指定类别）
const FIXED_META = {
  '000198': { name:'天治财富增长', cat:'active', type:'混合型', label:'主动权益' },
  '003003': { name:'华夏现金增利货币A', cat:'money', type:'货币型', label:'货币基金' },
  '070009': { name:'嘉实超短债债券A', cat:'bond', type:'债券型', label:'短债基金' },
};

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
  if (/后端|C$|E$|定期开放|定开/.test(name)) return null;
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

          // 近1年最大回撤（与r1时间窗口匹配，给scoreF短期Calmar用）
          const oneYearAgo = Date.now() - 365.25 * 24 * 60 * 60 * 1000;
          const nav1y = navData.filter(p => p.x >= oneYearAgo);
          if (nav1y.length >= 10) {
            let peak1 = 0, maxDD1 = 0;
            nav1y.forEach(p => {
              const v = p.y || 0;
              if (v > peak1) peak1 = v;
              if (peak1 > 0) {
                const dd = (peak1 - v) / peak1 * 100;
                if (dd > maxDD1) maxDD1 = dd;
              }
            });
            result.maxDD1y = Math.round(maxDD1 * 10) / 10;
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

// 拉取基金前10大重仓股（用于行业归因）
// 返回 [{code, name, pct}, ...] 或 null（QDII/无数据基金）
async function fetchTopStocks(code) {
  try {
    const body = await httpGetWithRetry(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&year=&month=`, {
      'Referer': 'https://fundf10.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)'
    });
    // 解析每行：序号 + 股票代码(6位) + 股票名 + ... + 占净值比例
    const re = /<tr><td>\d+<\/td><td><a[^>]*>(\d{6})<\/a><\/td><td[^>]*><a[^>]*>([^<]+)<\/a><\/td>[\s\S]*?<td class='tor'>([\d.]+)%<\/td>/g;
    const stocks = [];
    let m;
    while ((m = re.exec(body)) !== null) {
      stocks.push({ code: m[1], name: m[2], pct: parseFloat(m[3]) });
    }
    return stocks.length > 0 ? stocks : null;
  } catch (e) {
    console.warn(`    重仓股获取失败 ${code}: ${e.message}`);
    return null;
  }
}

// 加载股票→行业映射表（来自 update-industry-map.js 的输出）
let _stockIndustryMap = null;
function loadStockIndustryMap() {
  if (_stockIndustryMap !== null) return _stockIndustryMap;
  try {
    const p = path.join(__dirname, '..', 'data', 'stock-industry-map.json');
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    _stockIndustryMap = data.stocks || {};
    console.log(`  已加载股票→行业映射: ${Object.keys(_stockIndustryMap).length} 只`);
  } catch (e) {
    console.warn('  股票→行业映射表未找到，跳过行业归因（请先运行 update-industry-map.js）');
    _stockIndustryMap = {};
  }
  return _stockIndustryMap;
}

// 细分行业 → 大类板块映射（基于产业链相关性合并）
// 解决：主动基金持仓天然分散到产业链上下游，细分行业难以单独超过30%阈值
const INDUSTRY_GROUP = {
  // 通信链（光模块/光器件/通信设备/光纤/PCB）
  '通信设备': '通信', '通信服务': '通信', '元件': '通信',
  // 电子/半导体
  '半导体': '电子', '光学光电子': '电子', '消费电子': '电子',
  '计算机设备': '电子', '其他电子Ⅱ': '电子',
  // 软件互联网
  '软件开发': '科技', 'IT服务Ⅱ': '科技', '互联网服务': '科技',
  // 医药健康
  '化学制药': '医药', '中药Ⅱ': '医药', '生物制品': '医药',
  '医药商业': '医药', '医疗器械': '医药', '医疗服务': '医药',
  // 消费
  '白酒Ⅱ': '消费', '食品加工': '消费', '饮料乳品': '消费',
  '调味发酵品Ⅱ': '消费', '休闲食品': '消费', '家居用品': '消费',
  '服装家纺': '消费', '化妆品': '消费', '小家电': '消费',
  '白色家电': '消费', '黑色家电': '消费', '厨卫电器': '消费',
  // 新能源
  '电池': '新能源', '光伏设备': '新能源', '风电设备': '新能源',
  '电网设备': '新能源', '电机Ⅱ': '新能源', '其他电源设备Ⅱ': '新能源',
  // 汽车
  '汽车零部件': '汽车', '汽车整车': '汽车', '商用车': '汽车',
  '乘用车': '汽车', '汽车服务': '汽车',
  // 金融
  '股份制银行Ⅱ': '金融', '城商行Ⅱ': '金融', '国有大型银行Ⅱ': '金融',
  '农商行Ⅱ': '金融', '证券Ⅱ': '金融', '保险Ⅱ': '金融',
  '多元金融': '金融',
  // 周期/资源
  '煤炭开采': '资源', '石油开采': '资源', '油气开采Ⅱ': '资源',
  '工业金属': '资源', '小金属': '资源', '贵金属': '资源',
  '钢铁': '资源', '化学原料': '资源', '化学制品': '资源',
  '化学纤维': '资源', '橡胶': '资源', '塑料': '资源',
  // 军工
  '军工电子Ⅱ': '军工', '航空装备Ⅱ': '军工', '航天装备Ⅱ': '军工',
  '地面兵装Ⅱ': '军工', '航海装备Ⅱ': '军工',
  // 房地产建筑
  '房地产开发': '地产', '基础建设': '地产', '专业工程': '地产',
  '装修建材': '地产', '水泥': '地产', '玻璃玻纤': '地产',
  // 公用事业
  '电力': '公用', '燃气Ⅱ': '公用', '环境治理': '公用',
};

// 根据重仓股推断基金的实际板块
// 优先看大类板块（产业链合并），其次看细分行业，阈值25%
function inferFundSector(topStocks) {
  if (!topStocks || topStocks.length === 0) return null;
  const map = loadStockIndustryMap();
  if (Object.keys(map).length === 0) return null;

  const groupWeight = {}; // 大类板块权重
  const industryWeight = {}; // 细分行业权重
  let mappedTotal = 0;
  topStocks.forEach(s => {
    const entry = map[s.code];
    if (entry && entry.industry) {
      industryWeight[entry.industry] = (industryWeight[entry.industry] || 0) + s.pct;
      const group = INDUSTRY_GROUP[entry.industry] || entry.industry;
      groupWeight[group] = (groupWeight[group] || 0) + s.pct;
      mappedTotal += s.pct;
    }
  });
  if (mappedTotal < 10) return null; // 数据质量不足

  // 优先看大类板块（>25%即触发），其次看细分行业（>30%）
  const sortedGroup = Object.entries(groupWeight).sort((a, b) => b[1] - a[1]);
  if (sortedGroup.length > 0 && sortedGroup[0][1] > 25) {
    return sortedGroup[0][0];
  }
  const sortedIndustry = Object.entries(industryWeight).sort((a, b) => b[1] - a[1]);
  if (sortedIndustry.length > 0 && sortedIndustry[0][1] > 30) {
    return sortedIndustry[0][0];
  }
  return null;
}

// 细分行业 → 投资风格映射
// growth: 成长股（科技/医药生物/新能源/军工 - 高估值高增速）
// value:  价值股（金融/能源/周期/地产 - 低估值稳定）
// dividend: 红利股（银行/煤炭/电力/高速 - 高股息防御）
// blend:  混合（消费/家电 - 既不极端成长也非纯价值）
const INDUSTRY_STYLE = {
  // === Growth 成长 ===
  '通信设备': 'growth', '通信服务': 'growth', '元件': 'growth',
  '半导体': 'growth', '光学光电子': 'growth', '消费电子': 'growth',
  '计算机设备': 'growth', '其他电子Ⅱ': 'growth',
  '软件开发': 'growth', 'IT服务Ⅱ': 'growth', '互联网服务': 'growth',
  '化学制药': 'growth', '生物制品': 'growth', '医疗器械': 'growth', '医疗服务': 'growth',
  '电池': 'growth', '光伏设备': 'growth', '风电设备': 'growth',
  '电网设备': 'growth', '电机Ⅱ': 'growth', '其他电源设备Ⅱ': 'growth',
  '军工电子Ⅱ': 'growth', '航空装备Ⅱ': 'growth', '航天装备Ⅱ': 'growth',
  '地面兵装Ⅱ': 'growth', '航海装备Ⅱ': 'growth',
  '自动化设备': 'growth', '专用设备': 'growth',
  '汽车零部件': 'growth', // 新能源车产业链偏成长
  // === Value 价值 ===
  '股份制银行Ⅱ': 'value', '城商行Ⅱ': 'value', '国有大型银行Ⅱ': 'value',
  '农商行Ⅱ': 'value', '证券Ⅱ': 'value', '保险Ⅱ': 'value', '多元金融': 'value',
  '工业金属': 'value', '钢铁': 'value', '小金属': 'value', '贵金属': 'value',
  '化学原料': 'value', '化学纤维': 'value', '橡胶': 'value', '塑料': 'value',
  '房地产开发': 'value', '基础建设': 'value', '专业工程': 'value',
  '装修建材': 'value', '水泥': 'value', '玻璃玻纤': 'value',
  '物流': 'value', '航运港口': 'value', '铁路公路': 'value',
  // === Dividend 红利（高股息防御）===
  '煤炭开采': 'dividend', '石油开采': 'dividend', '油气开采Ⅱ': 'dividend',
  '电力': 'dividend', '燃气Ⅱ': 'dividend',
  // === Blend 混合（消费类传统行业，既不极端成长也非纯价值）===
  '白酒Ⅱ': 'blend', '食品加工': 'blend', '饮料乳品': 'blend',
  '调味发酵品Ⅱ': 'blend', '休闲食品': 'blend',
  '中药Ⅱ': 'blend', '医药商业': 'blend',
  '家居用品': 'blend', '服装家纺': 'blend', '化妆品': 'blend',
  '白色家电': 'blend', '黑色家电': 'blend', '厨卫电器': 'blend', '小家电': 'blend',
  '汽车整车': 'blend', '商用车': 'blend', '乘用车': 'blend', '汽车服务': 'blend',
  '环境治理': 'blend', '通用设备': 'blend',
};

// 根据重仓股推断基金的投资风格
// 返回 {style, distribution}：主导风格 + 各风格权重分布
function inferFundStyle(topStocks) {
  if (!topStocks || topStocks.length === 0) return null;
  const map = loadStockIndustryMap();
  if (Object.keys(map).length === 0) return null;

  const styleWeight = { growth: 0, value: 0, dividend: 0, blend: 0 };
  let mappedTotal = 0;
  topStocks.forEach(s => {
    const entry = map[s.code];
    if (entry && entry.industry) {
      const style = INDUSTRY_STYLE[entry.industry];
      if (style) {
        styleWeight[style] += s.pct;
        mappedTotal += s.pct;
      }
    }
  });
  if (mappedTotal < 10) return null; // 数据质量不足

  // 找主导风格（权重最高 > 40% 才确认）
  const sorted = Object.entries(styleWeight).sort((a, b) => b[1] - a[1]);
  const [topStyle, topWeight] = sorted[0];
  if (topWeight / mappedTotal > 0.40) {
    return {
      style: topStyle,
      distribution: {
        growth: Math.round(styleWeight.growth / mappedTotal * 100),
        value: Math.round(styleWeight.value / mappedTotal * 100),
        dividend: Math.round(styleWeight.dividend / mappedTotal * 100),
        blend: Math.round(styleWeight.blend / mappedTotal * 100),
      }
    };
  }
  // 无主导风格 → blend（混合型）
  return {
    style: 'blend',
    distribution: {
      growth: Math.round(styleWeight.growth / mappedTotal * 100),
      value: Math.round(styleWeight.value / mappedTotal * 100),
      dividend: Math.round(styleWeight.dividend / mappedTotal * 100),
      blend: Math.round(styleWeight.blend / mappedTotal * 100),
    }
  };
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
// 板块识别规则（顺序敏感，先匹配先得）
const SECTOR_RULES = [
  [/通信|5G|电信/, '通信'],
  [/半导体|芯片|集成电路/, '半导体'],
  [/人工智能|AI产业/, 'AI'],
  [/科技|信息技术|信息行业/, '科技'],
  [/互联|中概/, '互联网'],
  [/纳斯达克|纳指/, '纳斯达克'],
  [/标普|S&P/, '标普500'],
  [/沪深300|300ETF/, '沪深300'],
  [/中证500|500ETF/, '中证500'],
  [/中证1000|1000ETF/, '中证1000'],
  [/创业板/, '创业板'],
  [/科创板|科创50/, '科创板'],
  [/红利|股息/, '红利'],
  [/医疗|医药|健康/, '医疗'],
  [/消费/, '消费'],
  [/新能源|光伏|储能/, '新能源'],
  [/军工|国防/, '军工'],
  [/金融|银行|证券/, '金融'],
  [/电网|电力|能源/, '电力'],
  [/传媒|文化/, '传媒'],
];
function autoSector(name) {
  for (const [re, label] of SECTOR_RULES) {
    if (re.test(name)) return label;
  }
  return null;
}
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
      console.log(`  拉取 ${catInfo.label} Top 150…`);
      const pn = 150;
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
          if (detail.maxDD1y > 0 && detail.maxDD1y <= 100) f.maxDD1y = detail.maxDD1y;
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

      // 维度1: 近1年收益 Top 15
      [...withDetail].sort((a, b) => b.r1 - a.r1).slice(0, 15).forEach(f => selectedCodes.add(f.code));

      // 维度2: 长期风险调整收益 Top 15 (r3Ann/maxDD3y，分子分母同窗口，与scoreF calmarLong一致)
      [...withDetail].filter(f => (f.maxDD3y || f.maxDD) > 0 && f.r3 > -100).sort((a, b) => {
        const r3AnnA = (Math.pow(1 + a.r3/100, 1/3) - 1) * 100;
        const r3AnnB = (Math.pow(1 + b.r3/100, 1/3) - 1) * 100;
        const calA = r3AnnA / (a.maxDD3y || a.maxDD);
        const calB = r3AnnB / (b.maxDD3y || b.maxDD);
        return calB - calA;
      }).slice(0, 15).forEach(f => selectedCodes.add(f.code));

      // 维度3: 近3年收益 Top 15
      [...withDetail].filter(f => f.r3 > 0).sort((a, b) => b.r3 - a.r3).slice(0, 15).forEach(f => selectedCodes.add(f.code));

      // 合并去重，保留全部并集结果（三维各Top15，去重后约25-35只）
      const funds = allParsed.filter(f => selectedCodes.has(f.code));

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
    const dd1ys = funds.map(f => f.maxDD1y).filter(v => v > 0);
    const avgDD1y = dd1ys.length > 0 ? dd1ys.reduce((s, v) => s + v, 0) / dd1ys.length : 0;
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
      avgDD1y: Math.round(avgDD1y * 100) / 100,
      avgR3: Math.round(avgR3 * 100) / 100,
      count: r1s.length,
      ...(monthlyReturns.length >= 6 && { monthlyReturns })
    };
  }
  console.log('\n市场基准统计（基于全市场Top扫描，筛选前全量数据）:');
  for (const cat of Object.keys(finalBenchmarks)) {
    const b = finalBenchmarks[cat];
    console.log(`  ${cat}: avgR1=${b.avgR1}% stdR1=${b.stdR1}% avgDD=${b.avgDD}% avgDD1y=${b.avgDD1y}% count=${b.count}`);
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

  // 读取上次精选库数据，用于本次获取失败时保留旧数据
  const prevCuratedPath = path.join(__dirname, '..', 'data', 'curated-details.json');
  let prevFunds = {};
  try {
    const prev = JSON.parse(fs.readFileSync(prevCuratedPath, 'utf-8'));
    prevFunds = prev.funds || {};
  } catch(_) {}

  for (const code of dynamicCodes) {
    try {
      // 已有扫描数据的基金直接复用，只补充 r3（扫描阶段未拉取）
      const base = scannedMap[code];
      let detail = null;
      let r3 = null;

      if (base && base.maxDD > 0) {
        // 已有完整详情，只补 r3
        r3 = await fetchFundR3(code);
        detail = { r1: base.r1, maxDD: base.maxDD, maxDD3y: base.maxDD3y, maxDD1y: base.maxDD1y,
          manager: base.manager, mgrYears: base.mgrYears, star: base.stars, fundSize: base.size,
          fee: base.fee };
      } else {
        // 固定基金（货币/超短债）需单独拉取
        detail = await fetchFundDetail(code);
        r3 = await fetchFundR3(code);
      }

      if (detail) {
        const f = base || {};
        const meta = FIXED_META[code] || {};
        const entry = {
          name: f.name || meta.name || '',
          type: f.type || meta.type || '',
          cat: f.cat || meta.cat || '',
          label: f.label || meta.label || '',
          risk: f.risk || '',
        };
        if (detail.r1 !== undefined && isFinite(detail.r1)) entry.r1 = detail.r1;
        if (r3 !== null) entry.r3 = r3;
        if (detail.maxDD > 0 && detail.maxDD <= 100) entry.maxDD = detail.maxDD;
        if (detail.maxDD3y > 0 && detail.maxDD3y <= 100) entry.maxDD3y = detail.maxDD3y;
        if (detail.maxDD1y > 0 && detail.maxDD1y <= 100) entry.maxDD1y = detail.maxDD1y;
        if (detail.manager) entry.manager = detail.manager;
        if (detail.mgrYears > 0) entry.mgrYears = detail.mgrYears;
        if (detail.star >= 1 && detail.star <= 5) entry.stars = detail.star;
        if (detail.fundSize > 0) entry.size = Math.round(detail.fundSize * 100) / 100;
        if (detail.fee !== undefined) entry.fee = detail.fee;

        // 自动生成 reason、tags 和 sector（index基金板块标识，用于重叠检测）
        entry.tags = autoTags(entry);
        entry.reason = autoReason(entry);
        if (entry.cat === 'index') {
          const s = autoSector(entry.name || '');
          if (s) entry.sector = s;
        }

        // 行业归因（基于真实重仓股）：覆盖所有非QDII/非货币基金
        // 优先级高于 autoSector（基金名称匹配），因为底层持仓数据更准确
        if (entry.cat !== 'qdii' && entry.cat !== 'money') {
          const topStocks = await fetchTopStocks(code);
          if (topStocks && topStocks.length > 0) {
            entry.topStocks = topStocks;
            const inferredSector = inferFundSector(topStocks);
            if (inferredSector) {
              entry.sector = inferredSector; // 覆盖名称匹配的结果
              entry.sectorSource = 'topStocks';
            } else if (entry.sector) {
              entry.sectorSource = 'name';
            }
            // 风格归因：基于重仓股行业的 growth/value/dividend/blend 分布
            const styleResult = inferFundStyle(topStocks);
            if (styleResult) {
              entry.style = styleResult.style;
              entry.styleDistribution = styleResult.distribution;
            }
          }
          await sleep(200); // 限速保护
        }

        // 兜底：基金风格归因（QDII / 货币 / 重仓股拉取失败的基金）
        // 没有 entry.style 才进入兜底，避免覆盖前面基于真实持仓的归因
        if (!entry.style) {
          if (entry.cat === 'qdii') {
            // QDII 多数是海外科技/纳指/标普500/中概 → growth
            entry.style = /红利|股息|价值/.test(entry.name || '') ? 'dividend' : 'growth';
          } else if (entry.cat === 'money') {
            entry.style = 'cash'; // 现金等价，不参与风格分散讨论
          } else if (entry.cat === 'bond') {
            entry.style = 'bond'; // 债券，不参与风格分散讨论
          } else if (entry.cat === 'index') {
            // 指数基金按名称推断风格
            const name = entry.name || '';
            if (/红利|股息|低波|高股息/.test(name)) entry.style = 'dividend';
            else if (/价值|沪深300价值|基本面|银行|金融|煤炭|地产/.test(name)) entry.style = 'value';
            else if (/通信|半导体|芯片|科技|人工智能|AI|信息|互联网|新能源|医药|医疗|生物|军工|创业板/.test(name)) entry.style = 'growth';
            else if (/沪深300|上证50|中证100|大盘/.test(name)) entry.style = 'blend';
            else entry.style = 'blend';
          } else if (entry.cat === 'active') {
            // 主动基金没拉到重仓股 → 按名称粗略推断
            const name = entry.name || '';
            if (/红利|股息|价值/.test(name)) entry.style = 'value';
            else entry.style = 'blend';
          }
          if (entry.style) entry.styleSource = 'name'; // 标注来源
        } else {
          entry.styleSource = 'topStocks';
        }

        curatedResult.funds[code] = entry;
        curatedDone++;
      } else if (prevFunds[code]) {
        // detail为null（数据缺失）时保留上次数据
        curatedResult.funds[code] = { ...prevFunds[code], _stale: true };
        console.warn(`    ${code} detail为null，已保留上次数据`);
      }
    } catch (e) {
      console.warn(`    精选库详情失败 ${code}: ${e.message}`);
      // 获取失败时保留上次数据，避免基金因临时数据缺失被移出精选库
      if (prevFunds[code]) {
        curatedResult.funds[code] = { ...prevFunds[code], _stale: true };
        console.warn(`    已保留 ${code} 上次数据（标记为stale）`);
      }
    }
    await sleep(150);
  }

  // ═══ 自动获取指数PE百分位估值（中证指数官网，宽基+行业） ═══
  const INDEX_CODES = [
    // 宽基指数
    { code: '000300', name: '沪深300' },
    { code: '000905', name: '中证500' },
    { code: '000852', name: '中证1000' },
    { code: '000016', name: '上证50' },
    { code: '399006', name: '创业板指' },  // 深交所指数，中证官网可能无数据，fallback到静态值
    { code: '000922', name: '中证红利' },
    // 行业指数（覆盖精选库中的行业指数基金）
    { code: '930997', name: '中证有色金属' },
    { code: '930716', name: '中证5G通信' },
    { code: 'H30533', name: '中证互联网' },
    { code: '930050', name: '中证半导体' },
    { code: '399967', name: '中证新能源' },
    { code: '000991', name: '全指医药' },
    { code: '000932', name: '中证消费' },
  ];
  console.log('\n开始获取指数估值数据（中证指数官网）…');
  const indexValuation = {};
  const today = new Date();
  const endDate = today.toISOString().slice(0,10).replace(/-/g,'');
  const startDate10y = new Date(today - 10*365.25*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');

  for (const idx of INDEX_CODES) {
    try {
      const url = `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${idx.code}&startDate=${startDate10y}&endDate=${endDate}`;
      const body = await httpGetWithRetry(url, {
        'Referer': 'https://www.csindex.com.cn/',
        'User-Agent': 'Mozilla/5.0 (compatible; FundHelper/1.0)',
        'Accept': 'application/json'
      }, 30000);
      const json = JSON.parse(body);
      const data = (json.data || []).filter(r => r.peg > 0);
      if (data.length >= 100) {
        const latestPe = data[data.length - 1].peg;
        const pePct = Math.round(data.filter(r => r.peg < latestPe).length / data.length * 100);
        indexValuation[idx.code] = { name: idx.name, pe: Math.round(latestPe * 100) / 100, pePct, pbPct: pePct, updated: new Date().toISOString().slice(0, 7) };
        console.log(`  ${idx.name}(${idx.code}): PE=${latestPe.toFixed(2)} 百分位=${pePct}%（基于${data.length}个交易日）`);
      } else {
        console.warn(`  ${idx.name}: 数据不足（${data.length}条），跳过`);
      }
    } catch (e) {
      console.warn(`  估值获取失败 ${idx.name}: ${e.message}`);
    }
    await sleep(500);
  }

  // ═══ 获取十年期国债收益率（通过十年国债ETF净值变化推算利率环境） ═══
  // 注：直接获取国债收益率的免费API较少，此处用债券基金近1年收益率作为利率环境代理
  console.log('\n推算利率环境…');
  let bondYield = null;
  const bondBench = finalBenchmarks['bond'];
  if (bondBench && bondBench.avgR1 !== undefined) {
    // 债券基金近1年均收益 >5% 暗示利率下行环境，<2% 暗示利率上行/震荡
    // 映射到近似国债收益率区间：avgR1=2% → yield≈3.0%, avgR1=5% → yield≈2.3%, avgR1=0% → yield≈3.5%
    bondYield = Math.round(Math.max(1.5, Math.min(4.0, 3.5 - bondBench.avgR1 * 0.15)) * 1000) / 1000;
    console.log(`  债券基金近1年均收益: ${bondBench.avgR1.toFixed(2)}% → 推算利率环境: ${bondYield.toFixed(3)}%`);
  }

  // ═══ 沪深300 200日均线（用于 inferMomentumPhase 领先信号） ═══
  console.log('\n拉取沪深300历史净值（200日均线）…');
  let sh300Ma200 = null;
  try {
    const maUrl = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=20230101&end=29991231&lmt=300';
    const maBody = await httpGetWithRetry(maUrl, { 'Referer': 'https://www.eastmoney.com/' }, 15000);
    const maJson = JSON.parse(maBody);
    const klines = maJson.data && maJson.data.klines;
    if (klines && klines.length >= 200) {
      // 格式：日期,开盘,收盘,最高,最低,...  收盘价在 index 2
      const closes = klines.map(k => parseFloat(k.split(',')[2])).filter(v => !isNaN(v));
      if (closes.length >= 200) {
        const recent = closes.slice(-200);
        const ma200 = recent.reduce((s, v) => s + v, 0) / 200;
        const price = closes[closes.length - 1];
        const deviation = Math.round((price / ma200 - 1) * 1000) / 10;
        sh300Ma200 = { price, ma200: Math.round(ma200 * 100) / 100, above: price >= ma200, deviation };
        console.log(`  沪深300: 当前 ${price}, 200日均线 ${sh300Ma200.ma200}, 偏离 ${deviation}%`);
      }
    }
  } catch (e) {
    console.warn('  沪深300均线拉取失败:', e.message);
  }

  // 写入 curatedResult
  if (Object.keys(indexValuation).length > 0) curatedResult.indexValuation = indexValuation;
  if (bondYield !== null) curatedResult.bondYield = bondYield;
  if (sh300Ma200 !== null) curatedResult.marketBenchmarks._sh300Ma200 = sh300Ma200;

  const curatedPath = path.join(outDir, 'curated-details.json');
  fs.writeFileSync(curatedPath, JSON.stringify(curatedResult, null, 2), 'utf-8');
  console.log(`精选库详情完成！${curatedDone}/${dynamicCodes.size} 只成功，已写入 ${curatedPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
