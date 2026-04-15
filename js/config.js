// 精选基金库：运行时从 curated-details.json 动态加载，初始为空
let CURATED_FUNDS = [];
// 记录精选库数据的更新时间（来自 curated-details.json 的 timestamp 字段）
let _curatedTimestamp = null;
// 全市场基准统计（来自全市场扫描Top50/100，比精选库更广谱，用于z-score基准）
let MARKET_BENCHMARKS = {};

// 旧格式 curated-details.json 兼容映射（无 cat 字段时使用）
const _LEGACY_FUND_META = {
  '005827':{name:'易方达蓝筹精选混合',cat:'active',type:'混合型',fee:0.15},
  '110011':{name:'易方达优质精选混合',cat:'active',type:'混合型',fee:0.15},
  '161005':{name:'富国天惠成长混合A',cat:'active',type:'混合型',fee:0.15},
  '163402':{name:'兴全趋势投资混合',cat:'active',type:'混合型',fee:0.15},
  '003095':{name:'中欧医疗健康混合A',cat:'active',type:'混合型',fee:0.15},
  '260108':{name:'景顺长城新兴成长混合A',cat:'active',type:'混合型',fee:0.15},
  // 联接基金代码
  '460300':{name:'华泰柏瑞沪深300ETF联接A',cat:'index',type:'指数型',fee:0.012},
  '009051':{name:'易方达中证红利ETF联接A',cat:'index',type:'指数型',fee:0.012},
  '110026':{name:'易方达创业板ETF联接A',cat:'index',type:'指数型',fee:0.012},
  '160119':{name:'南方中证500ETF联接A',cat:'index',type:'指数型',fee:0.012},
  '160706':{name:'嘉实沪深300ETF联接A',cat:'index',type:'指数型',fee:0.012},
  // ETF 场内代码（旧数据用的是ETF代码）
  '510300':{name:'华泰柏瑞沪深300ETF',cat:'index',type:'指数型',fee:0.012},
  '515180':{name:'易方达中证红利ETF',cat:'index',type:'指数型',fee:0.012},
  '513050':{name:'易方达中证海外互联网ETF',cat:'qdii',type:'QDII',fee:0.02},
  '159915':{name:'易方达创业板ETF',cat:'index',type:'指数型',fee:0.012},
  '510500':{name:'南方中证500ETF',cat:'index',type:'指数型',fee:0.012},
  '159919':{name:'嘉实沪深300ETF',cat:'index',type:'指数型',fee:0.012},
  // 债券/货币/QDII
  '110017':{name:'易方达增强回报债券A',cat:'bond',type:'债券型',fee:0.07},
  '000171':{name:'易方达裕丰回报债券A',cat:'bond',type:'债券型',fee:0.05},
  '070009':{name:'嘉实超短债债券C',cat:'bond',type:'债券型',fee:0},
  '000198':{name:'天弘余额宝货币',cat:'money',type:'货币型',fee:0},
  '003003':{name:'华夏现金增利货币A',cat:'money',type:'货币型',fee:0},
  '161125':{name:'易方达标普500指数A',cat:'qdii',type:'QDII',fee:0.08},
  '270042':{name:'广发纳斯达克100ETF联接A',cat:'qdii',type:'QDII',fee:0.08},
  '040046':{name:'华安纳斯达克100ETF联接A',cat:'qdii',type:'QDII',fee:0.08},
  '006479':{name:'广发纳斯达克100ETF联接C',cat:'qdii',type:'QDII',fee:0},
  '006327':{name:'易方达中证海外互联网ETF联接A',cat:'qdii',type:'QDII',fee:0.02},
};

async function loadCuratedFunds() {
  try {
    const res = await fetch('data/curated-details.json?_=' + Date.now());
    const data = await res.json();
    _curatedTimestamp = data.timestamp || null;
    MARKET_BENCHMARKS = data.marketBenchmarks || {};
    // 动态覆盖指数估值数据（来自 fetch-ranks.js 自动爬取）
    if(data.indexValuation){
      Object.entries(data.indexValuation).forEach(([code, v]) => {
        INDEX_VALUATION[code] = { name:v.name, pePct:v.pePct, pbPct:v.pbPct, updated:v.updated };
      });
      console.log('[精选库] 已更新指数估值:', Object.entries(data.indexValuation).map(([c,v]) => `${v.name}(PE百分位=${v.pePct}%)`).join(', '));
    }
    // 加载十年期国债收益率（用于宏观信号补充）
    if(data.bondYield !== undefined) MARKET_BENCHMARKS._bondYield = data.bondYield;
    if(Object.keys(MARKET_BENCHMARKS).length > 0){
      console.log('[精选库] 已加载市场基准:', Object.keys(MARKET_BENCHMARKS).map(c => `${c}(avgR1=${MARKET_BENCHMARKS[c].avgR1}%,n=${MARKET_BENCHMARKS[c].count})`).join(', '));
    }
    const funds = [];
    Object.entries(data.funds || {}).forEach(([code, f]) => {
      const legacy = _LEGACY_FUND_META[code] || {};
      const cat = f.cat || legacy.cat;
      if (!cat) return;
      funds.push({
        code,
        name: f.name || legacy.name || code,
        type: f.type || legacy.type || '',
        cat,
        label: f.label || CAT_NAMES[cat] || cat,
        manager: f.manager || '',
        mgrYears: f.mgrYears || 0,
        stars: f.stars || 3,
        risk: f.risk || inferRiskFromDD(f.maxDD, cat),
        size: f.size || 0,
        r1: f.r1 || 0,
        r3: f.r3 || 0,
        maxDD: f.maxDD || 0,
        maxDD3y: f.maxDD3y || 0,
        fee: f.fee !== undefined ? f.fee : (legacy.fee !== undefined ? legacy.fee : getDefaultFee(cat)),
        vol: 0,
        tags: f.tags || [],
        reason: f.reason || '',
      });
    });
    CURATED_FUNDS = funds;
    // 精选库和市场基准加载完成后，重新初始化评分基准
    if(typeof getCatBenchmarks === 'function') _catBench = getCatBenchmarks();
    console.log(`[精选库] 已加载 ${funds.length} 只基金，数据时间：${_curatedTimestamp}`);
    // 更新页面上的精选库状态显示（顶部和底部）
    updateCuratedStatus(funds.length, _curatedTimestamp);
  } catch (e) {
    console.warn('[精选库] 加载失败，使用空库', e);
    updateCuratedStatus(0, null, true);
  }
}

function updateCuratedStatus(count, timestamp, isError = false) {
  const statusEl = document.getElementById('curated-update-status');
  const statusElModal = document.getElementById('curated-update-status-modal');
  const cardEl = document.getElementById('curated-status-card');

  if (isError) {
    const errorHtml = '<span style="color:#ff4d4f">❌ 数据加载失败</span>';
    if(statusEl) statusEl.innerHTML = errorHtml;
    if(statusElModal) statusElModal.innerHTML = errorHtml;
    if(cardEl) {
      cardEl.style.background = 'linear-gradient(135deg,#fff1f0,#ffccc7)';
      cardEl.style.borderColor = '#ffa39e';
    }
    return;
  }

  if (!timestamp) return;

  const d = new Date(timestamp);
  const dateStr = d.toLocaleDateString('zh-CN', {month:'numeric', day:'numeric'});
  const isStale = (Date.now() - d.getTime()) > 7 * 24 * 60 * 60 * 1000;

  if (isStale) {
    // 数据过期：警告样式
    const warnHtml = `<span style="color:#d46b08">⚠️ ${dateStr} · ${count} 只基金（已过期）</span>`;
    const warnDetail = `上次更新：${dateStr}（已超7天）<br><span style="color:#d46b08;font-weight:600">⚠️ 建议先更新数据再生成方案</span><br><span style="font-size:11px;color:#8c8c8c">GitHub Actions 每周一、四自动更新，或手动触发 workflow</span>`;
    if(statusEl) statusEl.innerHTML = warnDetail;
    if(statusElModal) statusElModal.innerHTML = warnHtml;
    if(cardEl) {
      cardEl.style.background = 'linear-gradient(135deg,#fffbe6,#fff7e6)';
      cardEl.style.borderColor = '#ffd591';
    }
  } else {
    // 数据正常：成功样式
    const okHtml = `<span style="color:#52c41a">✅ ${dateStr} · ${count} 只基金</span>`;
    const okDetail = `上次更新：${dateStr}<br><span style="color:#52c41a;font-weight:600">✅ 数据正常，共 ${count} 只精选基金</span><br><span style="font-size:11px;color:#8c8c8c">智能方案将从此库中推荐最优组合</span>`;
    if(statusEl) statusEl.innerHTML = okDetail;
    if(statusElModal) statusElModal.innerHTML = okHtml;
    if(cardEl) {
      cardEl.style.background = 'linear-gradient(135deg,#f6ffed,#f0f9ff)';
      cardEl.style.borderColor = '#b7eb8f';
    }
  }
}

function inferRiskFromDD(maxDD, cat) {
  if (cat === 'money') return 'R1';
  if (cat === 'bond') return maxDD > 5 ? 'R3' : maxDD > 2 ? 'R2' : 'R1';
  if (maxDD >= 45) return 'R5';
  if (maxDD >= 30) return 'R4';
  if (maxDD >= 15) return 'R3';
  if (maxDD >= 5) return 'R2';
  return 'R1';
}

// ═══════════════ 基金元数据增强（风格/行业/流动性风险） ═══════════════
const FUND_META = {
  '005827':{style:'large_value',industry:'消费',instPct:45,sizeQ:[-2,-5,-3,-1]},
  '110011':{style:'large_value',industry:'消费',instPct:52,sizeQ:[-3,-5,-4,-2]},
  '161005':{style:'large_growth',industry:'均衡',instPct:35,sizeQ:[0,-2,-1,1]},
  '163402':{style:'large_blend',industry:'均衡',instPct:30,sizeQ:[-1,-2,-1,0]},
  '003095':{style:'mid_growth',industry:'医药',instPct:40,sizeQ:[-8,-12,-5,-3]},
  '260108':{style:'large_growth',industry:'消费',instPct:48,sizeQ:[-5,-8,-6,-2]},
  '460300':{style:'large_blend',industry:'宽基',instPct:55,sizeQ:[5,3,8,10]},
  '009051':{style:'large_value',industry:'红利',instPct:60,sizeQ:[3,5,8,12]},
  '006327':{style:'large_growth',industry:'科技',instPct:38,sizeQ:[2,-5,0,5]},
  '110026':{style:'mid_growth',industry:'科技',instPct:42,sizeQ:[-2,-5,-3,0]},
  '160119':{style:'mid_blend',industry:'宽基',instPct:50,sizeQ:[1,-3,0,2]},
  '160706':{style:'large_blend',industry:'宽基',instPct:58,sizeQ:[2,1,3,5]},
  '110017':{style:'bond_credit',industry:'债券',instPct:65,creditGrade:'AA+',duration:2.5,sizeQ:[1,0,2,3]},
  '000171':{style:'bond_rate',industry:'债券',instPct:72,creditGrade:'AAA',duration:1.8,sizeQ:[-1,0,1,2]},
  '070009':{style:'bond_short',industry:'债券',instPct:55,creditGrade:'AAA',duration:0.3,sizeQ:[2,3,1,0]},
  '000198':{style:'money',industry:'货币',instPct:15,sizeQ:[0,0,0,0]},
  '003003':{style:'money',industry:'货币',instPct:30,sizeQ:[0,1,0,0]},
  '161125':{style:'large_blend',industry:'美股',instPct:35,sizeQ:[3,5,8,10]},
  '270042':{style:'large_growth',industry:'科技',instPct:28,sizeQ:[2,3,5,8]},
  '040046':{style:'large_blend',industry:'美股',instPct:32,sizeQ:[1,2,3,5]},
  '006479':{style:'large_blend',industry:'美股',instPct:25,sizeQ:[2,3,5,8]},
};
const STYLE_LABELS = {large_value:'大盘价值',large_blend:'大盘均衡',large_growth:'大盘成长',mid_value:'中盘价值',mid_blend:'中盘均衡',mid_growth:'中盘成长',bond_credit:'信用债',bond_rate:'利率债',bond_short:'短债',money:'货币'};
function getMeta(code){ return FUND_META[code]||{}; }

// ═══════════════ 暂停申购基金及替代方案 ═══════════════
// 支付宝等平台暂停申购的基金代码列表（需定期更新）
const SUSPENDED_FUNDS = new Set(['000198']); // 天弘余额宝货币
// 暂停基金的替代方案映射（同类型、同风险等级）
const FUND_ALTERNATIVES = {
  '000198': '003003', // 余额宝暂停 → 华夏现金增利货币
};
// 检查基金是否可购买，若暂停则返回替代基金代码
function checkFundAvailability(code){
  if(SUSPENDED_FUNDS.has(code)){
    return FUND_ALTERNATIVES[code] || null;
  }
  return code;
}

// 支付宝1折申购费率（第三方平台通常1折优惠，C类份额免申购费）
function getDefaultFee(cat){ return {active:0.15,index:0.012,bond:0.05,money:0,qdii:0.08}[cat]||0.10; }

// ═══════════════ 波动率估算 + 相关性矩阵 ═══════════════
const DD_TO_VOL = { active:2.8, index:3.0, bond:1.8, money:1.2, qdii:2.5 };
function estimateVol(f){
  if(f.vol > 0) return f.vol;
  return (f.maxDD||0) / (DD_TO_VOL[f.cat]||2.5);
}
const CORR_MATRIX = {
  active: { active:1.0, index:0.92, bond:-0.15, money:0.0, qdii:0.55 },
  index:  { active:0.92, index:1.0, bond:-0.10, money:0.0, qdii:0.50 },
  bond:   { active:-0.15, index:-0.10, bond:1.0, money:0.30, qdii:-0.05 },
  money:  { active:0.0, index:0.0, bond:0.30, money:1.0, qdii:0.0 },
  qdii:   { active:0.55, index:0.50, bond:-0.05, money:0.0, qdii:1.0 },
};
// CAT_NAMES
const CAT_NAMES  = { active:'主动权益', index:'指数基金', bond:'债券基金', money:'货币基金', qdii:'QDII海外' };
// CAT_TAG
const CAT_TAG={'active':'tag-active','index':'tag-index','bond':'tag-bond','money':'tag-money','qdii':'tag-qdii'};
// CAT_COLORS
const CAT_COLORS = { active:'#c41d7f', index:'#1677ff', bond:'#52c41a', money:'#d48806', qdii:'#722ed1' };

// ═══════════════ 全市场扫描分类配置 ═══════════════
const SCAN_CATEGORIES = [
  { ft:'gp', cat:'active', label:'股票型', type:'股票型' },
  { ft:'hh', cat:'active', label:'混合型', type:'混合型' },
  { ft:'zs', cat:'index', label:'指数型', type:'指数型' },
  { ft:'zq', cat:'bond',  label:'债券型', type:'债券型' },
  { ft:'qdii', cat:'qdii', label:'QDII', type:'QDII' },
];

// ═══════════════ 中国法定节假日 ═══════════════
const CN_HOLIDAYS_2025 = ['2025-01-01','2025-01-28','2025-01-29','2025-01-30','2025-01-31','2025-02-01','2025-02-02','2025-02-03','2025-02-04','2025-04-04','2025-04-05','2025-04-06','2025-05-01','2025-05-02','2025-05-03','2025-05-04','2025-05-05','2025-06-01','2025-06-02','2025-10-01','2025-10-02','2025-10-03','2025-10-04','2025-10-05','2025-10-06','2025-10-07','2025-10-08'];
const CN_HOLIDAYS_2026 = ['2026-01-01','2026-01-02','2026-01-03','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-04-05','2026-04-06','2026-04-07','2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05','2026-06-19','2026-06-20','2026-06-21','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'];
const CN_HOLIDAYS = new Set([...CN_HOLIDAYS_2025, ...CN_HOLIDAYS_2026]);

// ═══════════════ 估值信号：主要宽基指数PE百分位（静态内置，更新于2026-04） ═══════════════
// 百分位基于近10年历史数据，<30%=低估，>70%=高估
// 数据来源：Wind/理杏仁公开数据，每次「更新数据」时可手动刷新
const INDEX_VALUATION = {
  '000300': { name:'沪深300', pePct:42, pbPct:38, updated:'2026-04' }, // PE百分位42%，中性偏低
  '000905': { name:'中证500', pePct:35, pbPct:30, updated:'2026-04' }, // 中等偏低估
  '399006': { name:'创业板',  pePct:55, pbPct:52, updated:'2026-04' }, // 中性
  '000852': { name:'中证1000',pePct:32, pbPct:28, updated:'2026-04' }, // 偏低估
  '000016': { name:'上证50',  pePct:38, pbPct:35, updated:'2026-04' }, // 中性偏低
};
// 基金代码 → 对应指数代码映射
const FUND_VALUATION_MAP = {
  '460300':'000300','160706':'000300', // 沪深300联接
  '160119':'000905',                   // 中证500联接
  '110026':'399006',                   // 创业板联接
};
