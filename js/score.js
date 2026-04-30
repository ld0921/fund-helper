// ═══ 评分算法模块 ═══
function getCatBenchmarks(){
  // 优先使用全市场基准（来自全市场扫描Top50/100统计，比精选库更广谱）
  // 消除精选库的选择偏差（精选库只含Top10并集，均值严重偏高）
  if(typeof MARKET_BENCHMARKS === 'object' && Object.keys(MARKET_BENCHMARKS).length > 0){
    const result={};
    Object.keys(MARKET_BENCHMARKS).forEach(cat=>{
      const mb=MARKET_BENCHMARKS[cat];
      result[cat]={avgR1:mb.avgR1||0, avgR3:mb.avgR3||0, avgDD:mb.avgDD||0, stdR1:mb.stdR1||1, count:mb.count||0};
    });
    return result;
  }
  // 降级：从精选库计算（旧逻辑，仅在无市场基准时使用）
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
  // Alpha基准：各类别使用同类均值，避免跨市场比较偏差
  // - 主动基金：与同类主动基金均值比，衡量选股超额能力
  // - QDII基金：与同类QDII均值比（不与A股比，投资市场不同）
  // - 指数/债券/货币：用无风险利率（它们本身就是基准或低风险资产）
  // 时间窗口匹配：calmarShort 用1年基准(avgR1)，calmarLong 用3年年化基准(avgR3Ann)
  const bench = _catBench[f.cat];
  // 所有类别统一用同类均值作基准，消除跨类别评分不均衡
  const benchmarkShort = bench ? bench.avgR1 : RISK_FREE;
  const benchmarkLong  = bench && bench.avgR3 ? (Math.pow(1 + bench.avgR3/100, 1/3) - 1) * 100 : RISK_FREE;
  const calmarShort = (r1 - benchmarkShort) / dd3yAdj;
  const calmarLong  = (r3Ann - benchmarkLong) / dd3yAdj;
  const calmar = calmarShort * 0.6 + calmarLong * 0.4;
  // sigmoid中心点动态跟随同类均值calmar，消除熊市中系统性低估和区分度崩溃
  const calmarCenter = bench ? benchmarkLong / Math.max(bench.avgDD || 10, 1) : ((f.cat === 'bond' || f.cat === 'money') ? -0.3 : 0);
  const calmarScore = Math.round(32 / (1 + Math.exp(-(calmar - calmarCenter) * 1.5)));

  // 2. 收益一致性（权重 24%）
  //    中期(r1)与长期(r3)方向是否一致 + 幅度匹配度 + r3趋势强度
  //    同方向且幅度匹配 → 收益可持续性强
  let dirConsistency;
  if((r1 > 0 && r3 > 0) || (r1 < 0 && r3 < 0)){
    const absR1 = Math.abs(r1), absR3A = Math.abs(r3Ann);
    const ratio = Math.max(absR1, absR3A) > 0 ? Math.min(absR1, absR3A) / Math.max(absR1, absR3A) : 0;
    dirConsistency = r1 > 0 ? (4 + 6 * ratio) : (0 + 2 * ratio); // 双正4-10分，双负0-2分
  } else {
    // 方向不一致：近涨远跌（r1>0,r3<0）风险高得3分，近跌远涨（r1<0,r3>0）是回调得6分
    dirConsistency = (r1 > 0 && r3 < 0) ? 3 : 6;
  }
  // r3Strength：用超额r3（相对同类均值），避免牛市中所有基金趋近满分
  // 双负基金（r1<0且r3<0）：r3Strength基准从7降至0，避免连续亏损基金一致性分虚高
  const excessR3 = r3 - (bench && bench.avgR3 ? bench.avgR3 : 0);
  const r3Base = (r1 < 0 && r3 < 0) ? 0 : 7;
  const r3Strength = excessR3 > 0
    ? Math.min(14, r3Base + Math.log(1 + excessR3) / Math.log(101) * 7)
    : Math.max(0, r3Base - Math.log(1 + Math.abs(excessR3)) / Math.log(101) * 7);
  const consistencyScore = Math.min(24, dirConsistency + r3Strength);

  // 3. 任期稳定性 + 经理alpha（权重 22%）
  //    任期对数增长（5年饱和大部分分值）+ 信息比率（IR）补充能力维度
  //    IR = 超额收益 / 波动率，区分"靠市场涨"和"靠能力赚"
  const tenureScore = Math.min(14, Math.round(2 + Math.log(1 + mg) / Math.log(16) * 12)); // 任期部分：最高14分
  let alphaScore = 0;
  if(bench && bench.stdR1 > 0 && f.cat !== 'money'){
    const excessR1 = r1 - bench.avgR1;
    const ir = excessR1 / bench.stdR1; // 信息比率
    alphaScore = Math.round(Math.max(0, Math.min(8, 4 + ir * 2))); // IR=0→4分, IR=2→8分, IR=-2→0分
  } else {
    alphaScore = 4; // 货币基金或无基准数据，给中性分
  }
  const stabilityScore = Math.min(22, tenureScore + alphaScore);

  // 4. 规模适配性（权重 10%）
  //    指数基金：规模越大越好（流动性强、跟踪误差小）
  //    主动/QDII基金：50-500亿最优，太大调仓困难
  let sizeScore;
  if(f.cat === 'index'){
    sizeScore = sz >= 1000 ? 10 : sz >= 500 ? 10 : sz >= 50 ? 9 : sz >= 10 ? 7 : sz >= 2 ? 4 : 2;
  } else if(f.cat === 'bond'){
    sizeScore = sz >= 500 ? 10 : sz >= 100 ? 9 : sz >= 20 ? 7 : sz >= 5 ? 5 : 2; // 债券基金规模越大流动性越好
  } else {
    sizeScore = sz >= 1000 ? 4 : sz >= 500 ? 7 : sz >= 50 ? 10 : sz >= 10 ? 7 : sz >= 2 ? 4 : 2;
  }

  // 5. 费率优势（权重 12%）
  //    费率是预测基金长期表现的可靠指标，低费率长期复利优势显著
  let feeScore;
  feeScore = fee <= 0 ? 12 : Math.max(2, Math.round(12 - fee * 60));

  const total = Math.round(Math.min(100, Math.max(0, calmarScore + consistencyScore + stabilityScore + sizeScore + feeScore)));
  // 估值调整：指数基金用PE百分位，主动/qdii基金用相对同类均值的z-score（±5分）
  let valuationAdj = 0;
  if(f.cat === 'index'){
    valuationAdj = getValuationAdj(f.code);
  } else if((f.cat === 'active' || f.cat === 'qdii' || f.cat === 'bond') && bench && bench.stdR1 > 2){
    const z = (r1 - bench.avgR1) / bench.stdR1;
    valuationAdj = Math.round(Math.max(-8, Math.min(8, -z * 3.5))); // 超涨减分，超跌加分
  }
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
  // 双负基金大幅降分：r1<-3%且r3<-5% 直接返回低分，不走正常流程
  // 上限设为15分（低于正常流程最低约20分），确保双负惩罚真正生效
  if(f.r1 < -3 && f.r3 < -5) {
    const penalty = Math.min(15, Math.abs(f.r1) * 0.5 + Math.abs(f.r3) * 0.3);
    return Math.max(0, 15 - Math.round(penalty));
  }

  // 1. 波动适度性（定投核心指标，35%）
  // 优先用月度收益率标准差（σ）衡量真实波动，无数据时回退 maxDD 估算
  // 定投受益于震荡波动，但超高波动时散户大概率放弃，实际效果反降
  let volScore = 0;
  if(f.r3 > -20){
    let vol; // 月度收益率标准差（%）
    if(f.monthlyReturns && f.monthlyReturns.length >= 6){
      const mr = f.monthlyReturns;
      const mean = mr.reduce((s,v)=>s+v,0)/mr.length;
      vol = Math.sqrt(mr.reduce((s,v)=>s+(v-mean)**2,0)/mr.length);
    } else if(f.maxDD > 0){
      vol = f.maxDD / 5; // maxDD≈5σ 经验估算，降级回退
    }
    if(vol > 0){
      // 各类别最优月度σ区间（月度σ≈年化σ/√12）
      const optimalVol = {active:5, index:5, bond:0.8, qdii:7}[f.cat] || 5;
      const volSigma   = {active:3, index:3, bond:0.5, qdii:4}[f.cat] || 3;
      volScore = 35 * Math.exp(-Math.pow(Math.min(vol,20) - optimalVol, 2) / (2 * volSigma * volSigma));
      const r3Bonus = Math.min(1.0, (f.r3||0) / 30);
      volScore = volScore * (0.6 + 0.4 * r3Bonus);
    }
  }

  // 2. 长期趋势（25%）：用超额r3（相对同类均值），避免牛市中所有基金趋近满分
  const bench = _catBench[f.cat];
  const avgR3Dca = bench && bench.avgR3 ? bench.avgR3 : 0;
  const excessR3Dca = f.r3 - avgR3Dca;
  const trendScore = excessR3Dca > 0
    ? Math.max(5, Math.min(25, 13 + Math.log(1 + excessR3Dca) / Math.log(101) * 12))
    : Math.max(2, Math.min(25, 13 + excessR3Dca * 0.1));

  // 3. 管理质量（20%）：经理年限 + 超额Calmar（相对同类均值，替代r3/maxDD避免牛市区分度消失）
  const r3AnnDca = f.r3 > -100 ? (Math.pow(1 + f.r3/100, 1/3) - 1) * 100 : 0;
  const dd3yAdjDca = Math.max(0.1, f.maxDD3y || f.maxDD || 0.1);
  const avgCalmar = bench ? (bench.avgR3 ? (Math.pow(1+bench.avgR3/100,1/3)-1)*100 : RISK_FREE) / Math.max(bench.avgDD||10, 1) : 0;
  const excessCalmar = (r3AnnDca / dd3yAdjDca) - avgCalmar;
  const qualityScore = Math.min(12, (f.mgrYears||0) * 0.8) + Math.min(8, Math.max(0, 4 + excessCalmar * 2));

  // 4. 近期动量反转修正 r1（20%）：定投应在低位买入，近期涨太多反而不是好时机
  // 逻辑：r1跌幅大（但长期向上）→ 定投摊成本效果最佳；r1涨幅过大 → 可能均值回归
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
