// ═══ 评分算法模块 ═══
function getCatBenchmarks(){
  const cats = {};
  CURATED_FUNDS.forEach(f=>{
    if(!cats[f.cat]) cats[f.cat]={r1s:[],r3s:[],dds:[]};
    cats[f.cat].r1s.push(f.r1);
    cats[f.cat].r3s.push(f.r3);
    cats[f.cat].dds.push(f.maxDD);
  });
  const result={};
  Object.keys(cats).forEach(cat=>{
    const d=cats[cat];
    const avgR1=d.r1s.reduce((s,v)=>s+v,0)/d.r1s.length;
    const avgR3=d.r3s.reduce((s,v)=>s+v,0)/d.r3s.length;
    const avgDD=d.dds.reduce((s,v)=>s+v,0)/d.dds.length;
    const stdR1=Math.sqrt(d.r1s.reduce((s,v)=>s+(v-avgR1)**2,0)/d.r1s.length)||1;
    result[cat]={avgR1,avgR3,avgDD,stdR1,count:d.r1s.length};
  });
  return result;
}
function getValuationAdj(fundCode){
  const idxCode = FUND_VALUATION_MAP[fundCode];
  if(!idxCode) return 0;
  const v = INDEX_VALUATION[idxCode];
  if(!v) return 0;
  const pct = v.pePct;
  if(pct <= 20) return 10;
  if(pct <= 30) return 7;
  if(pct <= 40) return 3;
  if(pct <= 60) return 0;
  if(pct <= 70) return -3;
  if(pct <= 80) return -7;
  return -10;
}
// 获取估值标注文字（用于基金卡片显示）
function getValuationLabel(fundCode){
  const idxCode = FUND_VALUATION_MAP[fundCode];
  if(!idxCode) return '';
  const v = INDEX_VALUATION[idxCode];
  if(!v) return '';
  const adj = getValuationAdj(fundCode);
  const level = adj >= 7 ? '低估' : adj >= 3 ? '略低估' : adj <= -7 ? '高估' : adj <= -3 ? '略高估' : '中性';
  const color = adj > 0 ? '#52c41a' : adj < 0 ? '#ff4d4f' : '#8c8c8c';
  return `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${color}15;color:${color};border:1px solid ${color}40" title="PE百分位${v.pePct}%，数据更新于${v.updated}">估值${level}</span>`;
}
function scoreF(f){
  const r1=+f.r1||0, r3=+f.r3||0, dd=+(f.dd||f.maxDD)||0, sz=+f.size||0, mg=+(f.mgr||f.mgrYears)||0;
  const dd3y=+(f.maxDD3y)||dd; // 近3年回撤，无则回退全期
  const fee = f.fee !== undefined ? +f.fee : getDefaultFee(f.cat); // 费率

  // 1. Calmar Ratio（风险调整收益，权重 32%）
  //    时间窗口匹配原则：收益率和回撤应使用相同的时间窗口
  //    短期 Calmar = r1 / maxDD3y（r1是近1年，maxDD3y是近3年，窗口不完全匹配但无更精确数据）
  //    长期 Calmar = r3年化 / maxDD3y（都是近3年，时间窗口匹配）
  //    加权：短期60% + 长期40%，侧重近期表现但兼顾长期
  const r3Ann = r3 > -100 ? (Math.pow(1 + r3/100, 1/3) - 1) * 100 : 0; // r3累计转年化
  const dd3yAdj = Math.max(0.1, dd3y);
  // Alpha因子：主动/QDII基金用超额收益（r1 - 沪深300基准），衡量真实选股能力
  // 指数/债券/货币基金仍用超额无风险利率（它们本身就是基准或低风险资产）
  const isAlphaFund = f.cat === 'active' || f.cat === 'qdii';
  const benchmark = isAlphaFund && _benchmarkR1 !== null ? _benchmarkR1 : RISK_FREE;
  const calmarShort = (r1 - benchmark) / dd3yAdj;
  const calmarLong  = (r3Ann - benchmark) / dd3yAdj;
  const calmar = calmarShort * 0.6 + calmarLong * 0.4;
  const calmarScore = Math.min(32, Math.max(0, calmar * 16)); // 0-32分

  // 2. 收益一致性（权重 24%）
  //    中期(r1)与长期(r3)方向是否一致 + 幅度匹配度 + r3趋势强度
  //    同方向且幅度匹配 → 收益可持续性强
  let dirConsistency;
  if((r1 > 0 && r3 > 0) || (r1 < 0 && r3 < 0)){
    const absR1 = Math.abs(r1), absR3A = Math.abs(r3Ann);
    const ratio = Math.max(absR1, absR3A) > 0 ? Math.min(absR1, absR3A) / Math.max(absR1, absR3A) : 0;
    dirConsistency = r1 > 0 ? (4 + 6 * ratio) : (0 + 2 * ratio); // 双正4-10分，双负0-2分
  } else {
    dirConsistency = 5; // 方向不一致
  }
  const r3Strength = r3 > 50 ? 14 : r3 > 20 ? 11 : r3 > 0 ? Math.max(5, r3 * 0.28) : Math.max(0, 3 + r3 * 0.05);
  const consistencyScore = Math.min(24, dirConsistency + r3Strength); // 0-24分

  // 3. 任期稳定性（权重 22%）
  //    客观指标：基金经理任期年限
  //    任期<1年=可能刚更换经理（高风险），>5年=稳定，>10年=非常稳定
  //    替代主观的「星级评定」
  let stabilityScore;
  if(mg < 1) stabilityScore = 3;       // 刚更换经理，高不确定性
  else if(mg < 2) stabilityScore = 7;  // 磨合期
  else if(mg < 3) stabilityScore = 11; // 初步稳定
  else if(mg < 5) stabilityScore = 15; // 稳定
  else if(mg < 10) stabilityScore = 19;// 成熟
  else stabilityScore = 22;            // 超长任期，团队非常稳定
  // 0-22分

  // 4. 规模适配性（权重 10%）
  //    指数基金：规模越大越好（流动性强、跟踪误差小）
  //    主动/QDII基金：50-500亿最优，太大调仓困难
  let sizeScore;
  if(f.cat === 'index'){
    sizeScore = sz >= 1000 ? 10 : sz >= 500 ? 10 : sz >= 50 ? 9 : sz >= 10 ? 7 : sz >= 2 ? 4 : 2;
  } else {
    sizeScore = sz >= 1000 ? 4 : sz >= 500 ? 7 : sz >= 50 ? 10 : sz >= 10 ? 7 : sz >= 2 ? 4 : 2;
  }

  // 5. 费率优势（权重 12%）
  //    费率是预测基金长期表现的可靠指标，低费率长期复利优势显著
  let feeScore;
  if(fee <= 0) feeScore = 12;           // 货币基金/C类免申购费
  else if(fee <= 0.05) feeScore = 12;   // 超低费率
  else if(fee <= 0.08) feeScore = 10;   // 低费率指数/QDII
  else if(fee <= 0.12) feeScore = 8;    // 标准指数
  else if(fee <= 0.15) feeScore = 5;    // 标准主动
  else feeScore = 2;                    // 高费率
  // 0-12分

  const total = Math.round(Math.min(100, Math.max(0, calmarScore + consistencyScore + stabilityScore + sizeScore + feeScore)));
  // 估值调整：指数基金加入PE百分位信号，与calcDCAScore统一标准
  const valuationAdj = f.cat === 'index' ? getValuationAdj(f.code) : 0;
  return Math.max(0, Math.min(100, total + valuationAdj));
}

function scoreColor(s){ return s>=80?'#52c41a':s>=65?'#1677ff':s>=50?'#faad14':'#ff4d4f'; }
function recommend(s){
  if(s>=80)return'<span class="tag tag-bond">强烈推荐</span>';
  if(s>=65)return'<span class="tag tag-index">推荐</span>';
  if(s>=50)return'<span class="tag tag-money">可关注</span>';
  return'<span class="tag" style="background:#f5f5f5;color:var(--muted)">谨慎</span>';
}
function calcDCAScore(f){
  // 定投评分：波动适度性 + 长期趋势 + 管理质量 + 近期动量（去除当日择时信号）
  if(f.cat==='money') return 10; // 货币基金不适合定投
  // 双负基金大幅降分但不完全排除：周期性行业基金可能处于底部区间，仍有定投价值
  // 跌幅越深扣分越重，但保留最低分的可能性（让selectFunds的反转修正有机会评估）
  if(f.r1 < 0 && f.r3 < 0) {
    const penalty = Math.min(60, Math.abs(f.r1) * 0.5 + Math.abs(f.r3) * 0.3);
    return Math.max(0, 30 - Math.round(penalty));
  }

  // 1. 波动适度性（定投核心指标，35%）
  // 定投受益于波动，但超高波动（>35%）时散户大概率放弃定投，实际效果反降
  // 使用钟形曲线，最优DD按类别差异化（权益25%，QDII 20%，债券5%）
  let volScore = 0;
  if(f.r3 > 0 && f.maxDD > 0){
    const dd = Math.min(f.maxDD, 80);
    // 各类别最优定投波动率区间不同
    const optimalDD = {active:25, index:25, bond:5, qdii:20}[f.cat] || 22.5;
    const ddSigma = {active:12, index:12, bond:3, qdii:10}[f.cat] || 12;
    volScore = 35 * Math.exp(-Math.pow(dd - optimalDD, 2) / (2 * ddSigma * ddSigma));
    // 长期正收益加成：r3越高，波动越有价值
    const r3Bonus = Math.min(1.0, f.r3 / 30); // r3>=30%时加成满额
    volScore = volScore * (0.6 + 0.4 * r3Bonus); // 基础60% + r3加成40%
  }

  // 2. 长期趋势（25%）：定投看长期中枢方向，近3年下跌但波动大的基金反而适合定投摊成本
  //    不重度惩罚r3<0——下跌中的优质基金正是定投的黄金窗口
  // 长期趋势（25%）：连续函数，消除分档断层
  const trendScore = Math.max(5, Math.min(25, f.r3 > 0 ? 10 + f.r3 * 0.3 : 12 + f.r3 * 0.2));

  // 3. 管理质量（20%）：经理年限 + 星级
  const qualityScore = Math.min(12, (f.mgrYears||0) * 0.8) + Math.min(8, ((f.stars||3) - 1) * 2); // 0-20分

  // 4. 近期动量反转修正 r1（20%）：定投应在低位买入，近期涨太多反而不是好时机
  // 逻辑：r1跌幅大（但长期向上）→ 定投摊成本效果最佳；r1涨幅过大 → 可能均值回归
  const bench = _catBench[f.cat];
  const catAvgR1 = bench ? bench.avgR1 : 10;
  const catStdR1 = bench ? bench.stdR1 : 10;
  // 超涨（>均值+1σ）扣分，超跌（<均值-1σ）加分，中性区间正常计分
  let momentumScore;
  if(f.r1 > catAvgR1 + catStdR1){
    // 超涨：可能面临均值回归，定投时机不佳
    momentumScore = Math.max(2, 10 - (f.r1 - catAvgR1 - catStdR1) * 0.3);
  } else if(f.r1 < catAvgR1 - catStdR1){
    // 超跌但长期向上：定投摊成本黄金窗口
    momentumScore = Math.min(20, 15 + (catAvgR1 - catStdR1 - f.r1) * 0.2);
  } else {
    // 中性区间：正常计分
    momentumScore = Math.max(0, Math.min(15, f.r1 > 0 ? Math.min(f.r1 * 0.5, 15) : f.r1 * 0.3 + 5));
  }

  // 5. 估值信号（宽基指数专属，±10分）：低估加分，高估减分
  const valuationAdj = getValuationAdj(f.code);

  const base = Math.max(0, Math.min(100, Math.round(volScore + trendScore + qualityScore + momentumScore)));
  return Math.max(0, Math.min(100, base + valuationAdj));
}
