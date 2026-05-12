// ═══ 行情分析模块 ═══
function analyzeCategoryPerf(){
  const cats = ['qdii','active','index','bond','money'];
  return cats.map(cat=>{
    const funds = CURATED_FUNDS.filter(f=>f.cat===cat);
    const scores = funds.map(f=>{
      const nav = navCache[f.code];
      const todayChg = nav ? parseFloat(nav.gszzl)||0 : 0;
      // Calmar Ratio（时间窗口匹配：短期r1/maxDD3y + 长期r3Ann/maxDD）
      const dd3y = f.maxDD3y || f.maxDD;
      const r3Ann = f.r3 > -100 ? (Math.pow(1 + f.r3/100, 1/3) - 1) * 100 : 0;
      // Alpha Calmar：相对同类均值的超额收益，减少追涨偏差
      const bench = _catBench[f.cat];
      const alpha1 = bench ? f.r1 - bench.avgR1 : f.r1 - RISK_FREE;
      const alpha3 = bench && bench.avgR3 ? r3Ann - (Math.pow(1 + bench.avgR3/100, 1/3) - 1) * 100 : r3Ann - RISK_FREE;
      const calmarShort = dd3y > 0 ? alpha1 / dd3y : 0;
      const calmarLong  = f.maxDD > 0 ? alpha3 / f.maxDD : 0;
      const calmar = calmarShort * 0.6 + calmarLong * 0.4;
      // 趋势一致性：加权幅度（短期20% + 中期50% + 长期30%），比纯方向更精准
      const trendScore = todayChg * 0.2 + f.r1 * 0.5 + r3Ann * 0.3;
      const trendConsistency = trendScore > 2 ? 3 : trendScore > 0.5 ? 2 : trendScore > 0 ? 1 : trendScore > -0.5 ? -1 : trendScore > -2 ? -2 : -3;
      // 任期稳定性（客观指标）
      const stability = Math.min(f.mgrYears, 15) / 15 * 10; // 0-10
      // 综合评分：Calmar 50% + 趋势一致性 25% + 稳定性 20% + 实时动量 5%
      const composite = calmar * 10 * 0.5 + trendConsistency * 4 * 0.25 + stability * 0.20 + todayChg * 5 * 0.05;
      return { ...f, todayChg, calmar, trendConsistency, stability, composite };
    });
    const avgR1 = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) ? MARKET_BENCHMARKS[cat].avgR1 : funds.reduce((s,f)=>s+f.r1,0)/funds.length;
    const avgDD = funds.reduce((s,f)=>s+f.maxDD,0)/funds.length;
    const avgChg = scores.reduce((s,f)=>s+f.todayChg,0)/scores.length;
    const avgR3 = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) ? MARKET_BENCHMARKS[cat].avgR3 : funds.reduce((s,f)=>s+f.r3,0)/funds.length;
    const stdR1 = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) ? MARKET_BENCHMARKS[cat].stdR1 : Math.sqrt(funds.reduce((s,f)=>s+(f.r1-avgR1)**2,0)/funds.length)||1;
    const avgCalmar = scores.reduce((s,f)=>s+f.calmar,0)/scores.length;
    const catTrend = (avgChg > 0 ? 1 : avgChg < 0 ? -1 : 0) + (avgR1 > 0 ? 1 : -1) + (avgR3 > 0 ? 1 : -1);
    const avgStability = funds.reduce((s,f)=>s+Math.min(f.mgrYears,15)/15*10,0)/funds.length;
    const catScore = avgCalmar * 10 * 0.5 + catTrend * 4 * 0.25 + avgStability * 0.20 + avgChg * 5 * 0.05;
    scores.sort((a,b)=>b.composite-a.composite);
    return { cat, name:CAT_NAMES[cat], avgR1, avgDD, avgChg, avgR3, stdR1, avgCalmar, catTrend, catScore, riskAdj:avgCalmar, topFunds:scores };
  }).sort((a,b)=>b.catScore-a.catScore);
}

// ═══════════════ 市场动量信号（基于资产相对强弱） ═══════════════
// 注意：此模块基于各类资产近1年相对表现推断动量状态，本质是动量/相对强弱信号，
// 而非宏观经济周期判断（后者需要GDP/CPI/PMI等外部宏观数据）。
function inferMomentumPhase(catRanks){
  if(!catRanks || catRanks.length < 3) return { phase:'unknown', label:'数据不足', equityMult:1.0, bondMult:1.0 };

  // 优先用全市场基准（MARKET_BENCHMARKS），避免精选库选择偏差导致均值虚高
  const getAvgR1 = cat => {
    if(typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) return MARKET_BENCHMARKS[cat].avgR1 || 0;
    const c = catRanks.find(x=>x.cat===cat); return c ? c.avgR1 : 0;
  };
  const getAvgR3 = cat => {
    if(typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) return MARKET_BENCHMARKS[cat].avgR3 || 0;
    const c = catRanks.find(x=>x.cat===cat); return c ? c.avgR3 : 0;
  };
  const getAvgChg = cat => { const c = catRanks.find(x=>x.cat===cat); return c ? c.avgChg : 0; };
  const getStdR1 = cat => {
    if(typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS[cat]) return MARKET_BENCHMARKS[cat].stdR1 || 10;
    const c = catRanks.find(x=>x.cat===cat); return c ? c.stdR1 : 10;
  };

  // 多时间窗口加权信号：近3月(r3年化/4)*50% + 近1年*30% + 今日涨跌*20倍*20%
  // 降低r1权重，提升短期信号权重，减少6~12个月滞后
  const signal = cat => {
    const r1 = getAvgR1(cat);
    const r3m = getAvgR3(cat) > -100 ? (Math.pow(1 + getAvgR3(cat)/100, 1/3) - 1) * 100 / 4 * 12 : 0; // r3年化后近似3月值（年化%）
    const chg = getAvgChg(cat) * 20; // 今日涨跌放大20倍对齐量纲
    return r3m * 0.65 + r1 * 0.30 + chg * 0.05;
  };

  const equityR1 = (getAvgR1('active') + getAvgR1('index')) / 2;
  const bondR1 = getAvgR1('bond');
  const qdiiR1 = getAvgR1('qdii');
  const bondStd = getStdR1('bond');
  const qdiiStd = getStdR1('qdii');

  const equitySig = (signal('active') + signal('index')) / 2;
  const bondSig   = signal('bond');
  const qdiiSig   = signal('qdii');

  const spread = equitySig - bondSig;
  const spreadThreshold = Math.max(3, bondStd * 0.5);
  const equityStrong = spread > spreadThreshold && equitySig > 0;
  const equityWeak   = spread < -spreadThreshold || equitySig < 0;
  const bondStrong   = bondSig > 3 && spread < 0;
  const bondWeak     = bondSig < 1;
  const qdiiStrong   = qdiiSig > equitySig + qdiiStd * 0.3 && qdiiSig > 5;

  let phase, label, equityMult, bondMult, desc;

  // phase 参数映射（用于确认期回退）
  const _phaseParams = {
    overheat:    { label:'权益极端强势', equityMult:0.92, bondMult:0.95, desc:'权益涨幅显著高于历史均值且债券走弱，可能存在过热风险。建议控制仓位，警惕回调。' },
    global_bull: { label:'全球权益强势', equityMult:1.08, bondMult:0.93, desc:'A股与海外权益同步强势，全球风险偏好上升。可适度超配权益和QDII。' },
    recovery:    { label:'权益强势期',   equityMult:1.10, bondMult:0.93, desc:'权益类资产相对强势，动量信号偏多。债券仍有正收益。建议适度超配权益类资产。' },
    stagflation: { label:'全面弱势期',   equityMult:0.85, bondMult:0.93, desc:'权益和债券均表现不佳，市场缺乏明确趋势。防御为主，建议超配货币和短债。' },
    recession:   { label:'债券强势期',   equityMult:0.90, bondMult:1.10, desc:'债券相对强势，权益动量偏弱。避险情绪或降息预期驱动。建议超配债券类资产。' },
    qdii_opp:    { label:'QDII机会期',  equityMult:0.95, bondMult:1.0,  desc:'海外权益强于A股，全球资产分散配置价值凸显。可适度增加QDII配置。' },
    transition:  { label:'信号模糊期',   equityMult:0.95, bondMult:1.03, desc:'各类资产动量信号不明确，无明显趋势方向。建议均衡偏防守配置，小幅倾斜债券。' }
  };

  if(equityStrong && bondWeak && equitySig > 10){
    phase = 'overheat'; label = '权益极端强势';
    equityMult = 0.92; bondMult = 0.95;
    desc = '权益涨幅显著高于历史均值且债券走弱，可能存在过热风险。建议控制仓位，警惕回调。';
  } else if(qdiiStrong && equityStrong){
    phase = 'global_bull'; label = '全球权益强势';
    equityMult = 1.08; bondMult = 0.93;
    desc = 'A股与海外权益同步强势，全球风险偏好上升。可适度超配权益和QDII。';
  } else if(equityStrong && !bondWeak){
    phase = 'recovery'; label = '权益强势期';
    equityMult = 1.10; bondMult = 0.93;
    desc = '权益类资产相对强势，动量信号偏多。债券仍有正收益。建议适度超配权益类资产。';
  } else if(equityWeak && bondWeak){
    phase = 'stagflation'; label = '全面弱势期';
    equityMult = 0.85; bondMult = 0.93;
    desc = '权益和债券均表现不佳，市场缺乏明确趋势。防御为主，建议超配货币和短债。';
  } else if(equityWeak && bondStrong){
    phase = 'recession'; label = '债券强势期';
    equityMult = 0.90; bondMult = 1.10;
    desc = '债券相对强势，权益动量偏弱。避险情绪或降息预期驱动。建议超配债券类资产。';
  } else if(qdiiStrong && !equityStrong){
    phase = 'qdii_opp'; label = 'QDII机会期';
    equityMult = 0.95; bondMult = 1.0;
    desc = '海外权益强于A股，全球资产分散配置价值凸显。可适度增加QDII配置。';
  } else {
    phase = 'transition'; label = '信号模糊期';
    equityMult = 0.95; bondMult = 1.03;
    desc = '各类资产动量信号不明确，无明显趋势方向。建议均衡偏防守配置，小幅倾斜债券。';
  }

  // 十年期国债收益率修正：利率上行压制债券、利率下行利好债券
  const bondYield = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS._bondYield) || null;
  if(bondYield !== null){
    // 基准区间：2.5%-3.5% 为中性，低于2.5%利好债券，高于3.5%压制债券
    if(bondYield < 2.3){
      bondMult *= 1.05; // 低利率环境，债券有利
      desc += ' 国债收益率偏低（' + bondYield.toFixed(2) + '%），利率环境利好债券。';
    } else if(bondYield > 3.2){
      bondMult *= 0.95; // 高利率环境，债券承压
      equityMult *= 0.97; // 高利率也压制权益估值
      desc += ' 国债收益率偏高（' + bondYield.toFixed(2) + '%），利率环境对债券和权益估值构成压力。';
    }
  }

  // 沪深300 200日均线修正：领先信号，提前识别牛熊转换
  const sh300Ma200 = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS._sh300Ma200) || null;
  if(sh300Ma200 !== null){
    if(!sh300Ma200.above && sh300Ma200.deviation < -5){
      // 跌破均线超过5%：提前进入防御，下调权益乘数
      equityMult *= 0.95;
      desc += ` 沪深300跌破200日均线（偏离 ${sh300Ma200.deviation}%），趋势转弱，适当降低权益敞口。`;
    } else if(sh300Ma200.above && sh300Ma200.deviation > 5){
      // 站上均线超过5%：趋势确认，小幅上调权益乘数
      equityMult *= 1.03;
      desc += ` 沪深300站上200日均线（偏离 +${sh300Ma200.deviation}%），趋势向好。`;
    }
  }

  // phase 确认期：新 phase 需连续出现2次才切换，防止频繁调仓
  const prevPhaseData = JSON.parse(localStorage.getItem('_phaseHistory') || '{}');
  const prevPhase = prevPhaseData.phase || phase;
  const prevCount = prevPhaseData.count || 0;
  if(phase !== prevPhase){
    // 新 phase 出现，但还不切换（除非是高危状态直接切换）
    if(prevCount >= 1 || phase === 'overheat' || phase === 'stagflation'){
      // 已确认或高危状态，立即切换
      localStorage.setItem('_phaseHistory', JSON.stringify({phase, count:0}));
    } else {
      // 首次出现，暂不切换，沿用上次 phase
      localStorage.setItem('_phaseHistory', JSON.stringify({phase, count:1}));
      // 用回上次的 phase 对应参数
      const prev = _phaseParams[prevPhase];
      if(prev){ phase = prevPhase; label = prev.label; equityMult = prev.equityMult; bondMult = prev.bondMult; desc = prev.desc + '（新信号待确认）'; }
    }
  } else {
    localStorage.setItem('_phaseHistory', JSON.stringify({phase, count:0}));
  }

  return { phase, label, equityMult, bondMult, desc, equityR1, bondR1, qdiiR1, spread, spreadThreshold };
}

// 基金经理变更检测
function detectManagerChanges(){
  const warnings = [];
  CURATED_FUNDS.forEach(f => {
    if(f.mgrYears < 1){
      warnings.push({
        code: f.code,
        name: f.name,
        manager: f.manager,
        years: f.mgrYears,
        desc: `基金经理 ${f.manager} 任职仅 ${f.mgrYears < 0.5 ? '不足半年' : f.mgrYears.toFixed(1)+'年'}，可能为近期更换。新任经理的投资风格和业绩尚不稳定，建议谨慎。`
      });
    }
  });
  return warnings;
}
