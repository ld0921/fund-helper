// ═══ 信号引擎与健康监控模块 ═══
function runSignalEngine(){
  // 检查净值数据新鲜度：如果缓存数据超过1天，不运行信号引擎（避免使用过期数据）
  const lastRefreshTime = localStorage.getItem('lastNavRefreshTime');
  if(lastRefreshTime){
    const age = Date.now() - parseInt(lastRefreshTime);
    if(age > 24 * 60 * 60 * 1000){ // 超过24小时
      console.warn('[信号引擎] 净值数据已过期，跳过信号生成');
      return;
    }
  } else if(Object.keys(navCache).length === 0){
    // 没有任何净值数据
    return;
  }

  // 合并所有持仓来源（修复：使用 execLog 计算准确成本）
  const allHeld = [];
  existingHoldings.forEach(h=>{
    if(!allHeld.some(x=>x.code===h.code)){
      // 直接使用已计算好的 h.value，避免用 gsz 重新估算导致偏差
      const cost = h.amount || 0;
      const value = h.value || h.amount || 0;
      allHeld.push({code:h.code, name:h.name, value, cost, status:h.status||'confirmed'});
    }
  });
  dcaPlans.forEach(d=>{
    if(!allHeld.some(x=>x.code===d.code) && d.curval>0){
      // 使用 execLog 计算准确成本
      const executedCount = d.execLog ? Object.keys(d.execLog).filter(k => d.execLog[k]).length : 0;
      let cost;
      if(executedCount > 0){
        cost = executedCount * d.monthly;
      } else {
        // 如果没有 execLog，回退到估算
        const months = d.start ? Math.max(0, Math.floor((new Date()-new Date(d.start))/30/86400000)) : 0;
        cost = d.monthly * months;
      }
      allHeld.push({code:d.code, name:d.name, value:d.curval, cost:cost});
    }
  });

  if(!allHeld.length && !CURATED_FUNDS.length) return;

  const signals = [];
  const catRanks = Object.keys(navCache).length > 0 ? analyzeCategoryPerf() : null;

  // === 持仓信号（基于已持基金） ===
  allHeld.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const nav = navCache[h.code];
    if(!nav) return;

    // 验证数据日期：只有今日数据才计算涨跌信号
    const today = new Date().toISOString().slice(0,10);
    const navDate = nav.gztime ? nav.gztime.slice(0,10) : (nav.jzrq || '');
    const isToday = navDate === today;

    // 只有今日数据且市场开盘时才使用涨跌幅
    const chg = isToday && isMarketOpen() ? (parseFloat(nav.gszzl)||0) : 0;
    const pnlPct = h.cost > 0 ? (h.value-h.cost)/h.cost*100 : null;

    // 信号1：持仓基金大跌，可能是加仓机会或风险预警
    // 阈值按类别差异化：债券-1%即显著，权益需-3.5%
    const dropThreshold = {active:-3.5, index:-3.0, bond:-1.0, money:-0.3, qdii:-3.5}[fd?.cat] || -3;
    const minorDropThreshold = dropThreshold * 0.6;
    if(chg <= dropThreshold){
      // 计算该基金在持仓中的占比
      const totalValue = allHeld.reduce((s,x)=>s+x.value,0);
      const fundPct = totalValue > 0 ? h.value / totalValue * 100 : 0;
      // 超配阈值按类别差异化：货币基金作为现金储备通常是用户有意为之，提高容忍度
      const owThreshold = {money:60, bond:35, active:25, index:25, qdii:20}[fd?.cat] || 25;
      const alreadyOverweight = fundPct > owThreshold;
      // 判断是否处于下跌趋势（r1<0 说明不只是单日波动）
      const inDowntrend = fd && fd.r1 < 0;

      if(alreadyOverweight){
        signals.push({type:'warning', priority:1, code:h.code, name:h.name,
          title:`⚠️ ${h.name} 今日大跌 ${chg.toFixed(2)}%`,
          desc:`该基金已占持仓 ${fundPct.toFixed(0)}%（超配），不建议继续加仓。观察后续走势。`,
          action:'🛑 已超配，勿加仓'
        });
      } else if(inDowntrend){
        signals.push({type:'warning', priority:1, code:h.code, name:h.name,
          title:`⚠️ ${h.name} 今日大跌 ${chg.toFixed(2)}%`,
          desc:`近1年收益 ${fd.r1}%，处于下跌趋势中，不建议逆势加仓。等待趋势企稳后再考虑。`,
          action:'🛑 趋势未稳，观察'
        });
      } else if(fd && fd.r1>5 && fd.r3>0){
        signals.push({type:'info', priority:2, code:h.code, name:h.name,
          title:`📉 ${h.name} 今日大跌 ${chg.toFixed(2)}%`,
          desc:`长期趋势良好(1年${fd.r1}%/3年${fd.r3}%)且仓位不高(${fundPct.toFixed(0)}%)，可考虑小额补仓。`,
          action:'📈 可小额补仓'
        });
      } else {
        signals.push({type:'warning', priority:1, code:h.code, name:h.name,
          title:`⚠️ ${h.name} 今日大跌 ${chg.toFixed(2)}%`,
          desc:`建议观察是否有重大利空，必要时考虑减仓止损。`,
          action:'🛑 观察或减仓'
        });
      }
    } else if(chg <= minorDropThreshold){
      signals.push({type:'info', priority:2, code:h.code, name:h.name,
        title:`📉 ${h.name} 今日下跌 ${chg.toFixed(2)}%`,
        desc:'显著下跌，建议关注原因。若为短期市场波动，可持有观察。',
        action:'👀 持续关注'
      });
    }

    // 信号2：持仓基金大涨（≥3%）或近1年超涨（r1超同类均值1.5σ），考虑部分止盈
    const catBench = catRanks && fd ? catRanks.find(c=>c.cat===fd.cat) : null;
    const overheated = catBench && catBench.stdR1 > 0 && fd.r1 > catBench.avgR1 + catBench.stdR1 * 1.5;
    if(chg >= 3 || (pnlPct !== null && pnlPct > 20 && overheated)){
      const triggerDesc = chg >= 3 ? `今日大涨 ${chg.toFixed(2)}%` : `近1年超涨（+${fd.r1}%，超同类均值${(fd.r1-catBench.avgR1).toFixed(1)}%）`;
      signals.push({type:'success', priority:2, code:h.code, name:h.name,
        title:`🚀 ${h.name} ${triggerDesc}`,
        desc: pnlPct!==null && pnlPct > 20
          ? `持仓已盈利 ${pnlPct.toFixed(1)}%，可考虑部分止盈锁定利润。`
          : '涨幅可观，持续关注后续走势。',
        action: pnlPct!==null && pnlPct>20 ? '💰 可部分止盈' : '✅ 继续持有'
      });
    }

    // 信号3：持仓亏损超过历史最大回撤的80%（仅已确认持仓，待确认成本基准不可靠）
    if(fd && pnlPct !== null && pnlPct < 0 && fd.maxDD > 0 && h.status === 'confirmed'){
      const ddRatio = -pnlPct / fd.maxDD;
      if(ddRatio > 0.8){
        signals.push({type:'danger', priority:0, code:h.code, name:h.name,
          title:`🔴 ${h.name} 亏损已达历史极端水平`,
          desc:`当前亏损 ${pnlPct.toFixed(1)}%，已达历史最大跌幅(${fd.maxDD}%)的 ${(ddRatio*100).toFixed(0)}%。建议严格评估是否需要止损。`,
          action:'🛑 建议止损评估'
        });
      }
    }

    // 信号4：持仓基金结构性下行（1年和3年均亏）
    if(fd && fd.r1 < -5 && fd.r3 < -10){
      signals.push({type:'danger', priority:1, code:h.code, name:h.name,
        title:`🔴 ${h.name} 结构性下行`,
        desc:`近1年 ${fd.r1}%，近3年 ${fd.r3}%，持续下行趋势明显。建议考虑换入同类更优基金。`,
        action:'🔄 建议换基'
      });
    }
  });

  // === 市场机会信号（基于行情分析） ===
  if(catRanks){
    // 信号5：某类别整体大跌（定投加仓机会）+ 结合估值信号
    catRanks.forEach(c=>{
      if(c.avgChg <= -2.0 && c.avgR1 > 0 && c.catTrend <= 0 && ['active','index','qdii'].includes(c.cat)){
        const isHeld = allHeld.some(h=>{
          const fd=CURATED_FUNDS.find(f=>f.code===h.code);
          return fd && fd.cat === c.cat;
        });
        const undervalued = Object.keys(FUND_VALUATION_MAP).some(fc=>{
          const fd=CURATED_FUNDS.find(f=>f.code===fc);
          return fd && fd.cat===c.cat && getValuationAdj(fc)>=3;
        });
        const valuationHint = undervalued ? `，且当前估值偏低（PE百分位<40%），定投性价比高` : '';
        signals.push({type:'opportunity', priority:2, code:'_cat_'+c.cat, name:c.name,
          title:`📊 ${c.name}板块整体回调 ${c.avgChg.toFixed(2)}%`,
          desc: isHeld
            ? `你持有该板块基金，板块回调可能是定投加仓的好时机（长期均收益 +${c.avgR1.toFixed(1)}%）${valuationHint}。`
            : `该板块长期均收益 +${c.avgR1.toFixed(1)}%，当前回调可关注是否有建仓机会${valuationHint}。`,
          action: isHeld ? '📈 定投加仓时机' : '👀 可关注建仓'
        });
      }

      // 信号6：某类别连续强势
      if(c.avgChg >= 1.5 && c.catTrend >= 2){
        signals.push({type:'info', priority:3, code:'_cat_'+c.cat, name:c.name,
          title:`🔥 ${c.name}板块持续强势 +${c.avgChg.toFixed(2)}%`,
          desc:`三维趋势(短/中/长)一致向上，Calmar Ratio ${c.avgCalmar.toFixed(2)}。若未持有可关注，已持有建议持有享受趋势。`,
          action:'✅ 趋势向好'
        });
      }
    });
  }

  // === 定投提醒（按用户设置的扣款日触发，前后1天提醒） ===
  if(dcaPlans.length > 0){
    const today = new Date();
    const dayOfMonth = today.getDate();
    console.log(`[定投提醒] 今天是${dayOfMonth}号，检查${dcaPlans.length}个定投计划`);
    // 收集今天需要提醒的定投计划（扣款日当天或前1天）
    const duePlans = dcaPlans.filter(d=>{
      const dd = d.deductDay || 10;  // 默认10号，与定投跟踪模块保持一致
      // 当月最后一天（28-31号）且扣款日为1号时，提前提醒下月扣款
      const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
      const isMonthEnd = dd === 1 && dayOfMonth === lastDayOfMonth;
      const shouldRemind = dayOfMonth === dd || dayOfMonth === dd - 1 || isMonthEnd;
      console.log(`[定投提醒] ${d.name}: 扣款日=${dd}号, 是否提醒=${shouldRemind}`);
      return shouldRemind;
    });
    if(duePlans.length > 0){
      const totalDue = duePlans.reduce((s,d)=>s+d.monthly,0);
      const planNames = duePlans.map(d=>`${d.name}(¥${d.monthly})`).join('、');
      signals.push({type:'info', priority:4, code:'_dca_remind', name:'定投提醒',
        title:`📅 定投扣款提醒`,
        desc:`${duePlans.length} 项定投即将扣款：${planNames}，合计 ¥${totalDue.toLocaleString()}。请确保支付宝余额充足。`,
        action:'执行定投'
      });
    }
    // 月初总览提醒（1-2号）
    if(dayOfMonth <= 2){
      const totalMonthly = dcaPlans.reduce((s,d)=>s+d.monthly,0);
      signals.push({type:'info', priority:5, code:'_dca_monthly', name:'本月定投总览',
        title:`📊 本月定投总览`,
        desc:`共 ${dcaPlans.length} 项定投计划，本月需投入 ¥${totalMonthly.toLocaleString()}。坚持纪律是定投成功的关键。`,
        action:'查看计划'
      });
    }
  }

  // 按优先级排序
  signals.sort((a,b) => a.priority - b.priority);

  // 去重：同一code只保留最高优先级信号
  const seen = new Set();
  const uniqueSignals = signals.filter(s => {
    if(seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });

  // 渲染信号横幅
  renderSignalBanner(uniqueSignals);
  // 信号列表溢出检测（显示渐变遮罩提示可滚动）
  setTimeout(()=>{
    const banner=document.getElementById('signal-banner');
    if(banner) banner.classList.toggle('has-overflow', banner.scrollHeight > banner.clientHeight + 20);
  },100);
  // 更新Tab角标
  const highPriorityCount = uniqueSignals.filter(s=>s.priority<=1).length;
  updateTabBadge(highPriorityCount);

  // 发送浏览器通知（仅对重要信号）
  const importantSignals = uniqueSignals.filter(s => s.priority <= 1);
  if(importantSignals.length > 0){
    const hash = importantSignals.map(s=>s.code+s.title).join('|');
    if(hash !== _lastSignalHash){
      _lastSignalHash = hash;
      sendBrowserNotification(importantSignals);
    }
  }
}

function renderSignalBanner(signals){
  const bell = document.getElementById('signal-bell');
  const badge = document.getElementById('signal-badge');
  const titleEl = document.getElementById('signal-modal-title');

  // 保存当前信号到全局变量，供弹窗使用
  window._currentSignals = signals;

  // 获取已读消息列表
  let readSignals = JSON.parse(localStorage.getItem('_readSignals') || '[]');

  // 清理过期的已读消息（超过24小时）
  const now = Date.now();
  readSignals = readSignals.filter(s => (now - s.readTime) < 24 * 60 * 60 * 1000);
  localStorage.setItem('_readSignals', JSON.stringify(readSignals));

  // 计算未读信号数量
  const readHashes = new Set(readSignals.map(s => s.hash));
  const unreadSignals = signals.filter(signal => {
    const hash = signal.code + signal.title;
    return !readHashes.has(hash);
  });

  if(unreadSignals.length === 0){
    // 无未读信号：隐藏角标
    if(badge) badge.style.display = 'none';
    if(titleEl) titleEl.textContent = '📡 智能监控 · 暂无新消息';
  } else {
    // 显示角标数字（仅显示未读数量）
    if(badge){
      badge.style.display = '';
      badge.textContent = unreadSignals.length > 99 ? '99+' : unreadSignals.length;
    }
    if(titleEl) titleEl.textContent = `📡 智能监控 · ${unreadSignals.length} 条新消息`;
  }

  // 渲染信号列表（检查函数是否存在）
  if(typeof window.renderSignalLists === 'function'){
    window.renderSignalLists();
  }

  // 有危险信号且是新信号时才自动弹出
  const dangerCount = unreadSignals.filter(s=>s.type==='danger'||s.type==='warning').length;
  if(dangerCount > 0){
    const dangerHash = unreadSignals.filter(s=>s.type==='danger'||s.type==='warning').map(s=>s.code+s.title).join('|');
    if(dangerHash !== _lastDangerHash){
      _lastDangerHash = dangerHash;
      openSignalModal();
    }
  }
}

function sendBrowserNotification(signals){
  if(!('Notification' in window)) return;
  if(Notification.permission !== 'granted') return;

  signals.forEach(s => {
    try {
      new Notification(s.title, {
        body: s.desc.substring(0, 100),
        icon: 'icons/icon-192.png',
        tag: 'fund-signal-' + s.code, // 防止重复通知
        renotify: true,
      });
    } catch(e){ /* iOS PWA may not support all options */ }
  });
}

// 请求通知权限
function requestNotificationPermission(){
  if(!('Notification' in window)) return;
  if(Notification.permission === 'default'){
    // 延迟请求，不在页面一加载就弹出
    setTimeout(()=>{
      Notification.requestPermission();
    }, 10000); // 10秒后请求
  }
}

// ═══════════════ 持仓健康诊断（动态阈值 + 集中度分析 + 区分持仓/定投） ═══════════════
function runHealthMonitor(){
  // 检查净值数据新鲜度：如果缓存数据超过1天，不运行健康监控（避免使用过期数据）
  const lastRefreshTime = localStorage.getItem('lastNavRefreshTime');
  if(lastRefreshTime){
    const age = Date.now() - parseInt(lastRefreshTime);
    if(age > 24 * 60 * 60 * 1000){ // 超过24小时
      console.warn('[健康监控] 净值数据已过期，跳过诊断');
      const wrap = document.getElementById('health-monitor-wrap');
      if(wrap) wrap.innerHTML = '';
      return;
    }
  } else if(Object.keys(navCache).length === 0){
    // 没有任何净值数据
    const wrap = document.getElementById('health-monitor-wrap');
    if(wrap) wrap.innerHTML = '';
    return;
  }

  const wrap = document.getElementById('health-monitor-wrap');

  // 分别收集持仓和定投计划
  const holdings = [];
  const dcaHoldings = [];

  existingHoldings.forEach(h=>{
    if(!holdings.some(x=>x.code===h.code)){
      const nav = navCache[h.code];
      const curNav = nav ? parseFloat(nav.gsz)||1 : 1;
      const cost = h.amount || h.value || 0;
      const value = h.amount ? (h.amount / (h.cost||curNav) * curNav) : (h.value||0);
      holdings.push({code:h.code, name:h.name, value, cost, source:'existing', date:h.date});
    }
  });

  dcaPlans.forEach(d=>{
    if(dcaHoldings.some(x=>x.code===d.code)) return; // 同一定投计划不重复

    // 使用 execLog 计算准确成本
    const executedCount = d.execLog ? Object.keys(d.execLog).filter(k => d.execLog[k]).length : 0;
    let cost;
    if(executedCount > 0){
      cost = executedCount * d.monthly;
    } else {
      // 如果没有 execLog，回退到估算
      const months = d.start ? Math.max(0, Math.floor((new Date()-new Date(d.start))/30/86400000)) : 0;
      cost = d.monthly * months;
    }

    dcaHoldings.push({
      code: d.code,
      name: d.name,
      value: d.curval || 0,
      cost: cost,
      source: 'dca',
      monthly: d.monthly,
      paused: d.paused || false
    });
  });

  if(!holdings.length && !dcaHoldings.length){ wrap.innerHTML=''; return; }

  // 优先使用全市场基准（与 scoreF 的 _catBench 保持一致）
  const catStats = {};
  ['active','index','bond','money','qdii'].forEach(cat=>{
    if(_catBench && _catBench[cat]){
      catStats[cat] = { avgR1: _catBench[cat].avgR1, stdR1: _catBench[cat].stdR1, count: _catBench[cat].count||0 };
    } else {
      const fs=CURATED_FUNDS.filter(f=>f.cat===cat);
      if(!fs.length) return;
      const avgR1 = fs.reduce((s,f)=>s+f.r1,0)/fs.length;
      const stdR1 = Math.sqrt(fs.reduce((s,f)=>s+(f.r1-avgR1)**2,0)/fs.length)||1;
      catStats[cat] = { avgR1, stdR1, count:fs.length };
    }
  });

  const catRanksCache = Object.keys(navCache).length>0 ? analyzeCategoryPerf() : null;

  // 读取最新智能推荐方案，用于联动诊断（避免对"建议加仓/持有"的基金发出矛盾黄警）
  // 只信任 7 天内的方案，过期则忽略
  let latestPlanActions = {};
  try {
    const raw = localStorage.getItem('lastRebalancePlan');
    if(raw){
      const plan = JSON.parse(raw);
      const age = Date.now() - (plan.timestamp || 0);
      if(age < 7 * 24 * 60 * 60 * 1000 && Array.isArray(plan.actions)){
        plan.actions.forEach(a => { if(a.code) latestPlanActions[a.code] = a.action; });
      }
    }
  } catch(e){ console.warn('读取 lastRebalancePlan 失败:', e); }
  // 集中度和总市值计算时去重（同一基金不重复计入）
  const uniqueHeld = [];
  const seenCodes = new Set();
  [...holdings, ...dcaHoldings].forEach(h=>{
    if(!seenCodes.has(h.code)){ seenCodes.add(h.code); uniqueHeld.push(h); }
  });
  const totalPortValue = uniqueHeld.reduce((s,h)=>s+h.value,0);

  const holdingAlerts = [];
  const holdingOkList = [];
  const dcaAlerts = [];
  const dcaOkList = [];

  // 集中度检查（去重后计算，避免同一基金双重计入）
  const catConcentration = {};
  uniqueHeld.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const cat = fd ? fd.cat : 'other';
    catConcentration[cat] = (catConcentration[cat]||0) + h.value;
  });
  // 类别集中度警告（权益类合计 > 80% 或单一类别 > 60%）
  const equityConc = ((catConcentration.active||0) + (catConcentration.index||0) + (catConcentration.qdii||0)) / (totalPortValue||1) * 100;
  const catConcAlerts = [];
  if(equityConc > 80) catConcAlerts.push(`权益类资产（主动+指数+QDII）占总仓位 ${equityConc.toFixed(0)}%，超过80%，建议适当配置债券或货币基金降低风险`);
  Object.entries(catConcentration).forEach(([cat, val])=>{
    const pct = val / (totalPortValue||1) * 100;
    if(pct > 60 && cat !== 'other') catConcAlerts.push(`${CAT_NAMES[cat]||cat}类占总仓位 ${pct.toFixed(0)}%，超过60%集中度警戒线`);
  });

  // ========== 诊断持仓基金（短期视角，严格标准） ==========
  holdings.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const nav = navCache[h.code];
    // 非交易日（周末/节假日）的估值数据是上一交易日残留，不应作为"今日"展示
    const todayChg = (nav && typeof isTradingDay === 'function' && isTradingDay()) ? parseFloat(nav.gszzl)||0 : null;
    const pnlPct = h.cost>0 ? (h.value-h.cost)/h.cost*100 : null;
    const pct = totalPortValue > 0 ? h.value / totalPortValue * 100 : 0;
    const issues = [];
    let level = 'green';

    // 集中度检查
    if(pct > 40){
      issues.push(`单只基金占总持仓 ${pct.toFixed(1)}%，超过40%集中度警戒线，建议分散配置`);
      level = 'yellow';
    }

    if(!fd){
      // 检查是否是近期通过智能方案推荐加入的（recommendHistory 里有记录且不足4周）
      let inProtection = false;
      let weeksAgo = 99;
      try {
        const recHistory = JSON.parse(localStorage.getItem('recommendHistory') || '[]');
        const rec = recHistory.filter(r => r.code === h.code).sort((a,b) => new Date(b.date) - new Date(a.date))[0];
        if(rec){
          weeksAgo = Math.floor((Date.now() - new Date(rec.date).getTime()) / (7 * 86400000));
          inProtection = weeksAgo < 4;
        }
      } catch(_){}
      const libNote = inProtection
        ? `该基金已移出本周精选库（智能方案推荐 ${weeksAgo} 周前），可能因评分下滑/经理变更/规模异常被替换。建议重新生成方案评估是否换仓。`
        : `该基金不在精选库中，无法进行详细诊断。建议重新生成智能方案，评估是否换入同类更优基金。`;
      if(pnlPct!==null && pnlPct < -15){
        issues.push(`持仓亏损 ${pnlPct.toFixed(1)}%，已超过-15%预警线。该基金不在精选库`);
        level = 'red';
      }
      if(issues.length){
        holdingAlerts.push({code:h.code,name:h.name,level, desc:issues.join('；')+'。', action:level==='red'?'🔴 建议减仓':'🟡 需分散', source:'existing'});
      } else {
        holdingOkList.push({code:h.code,name:h.name,level: inProtection ? 'yellow' : 'green',
          desc:`${libNote}${pnlPct!==null?` 当前${pnlPct>=0?'盈利':'亏损'} ${Math.abs(pnlPct).toFixed(1)}%。`:''} ${todayChg!==null?`今日 ${todayChg>0?'+':''}${todayChg.toFixed(2)}%。`:''}`,
          action: inProtection ? '🟡 关注观察' : '🟢 持有', source:'existing',
          extraAction: `<button onclick="switchTab(0)" style="margin-top:6px;padding:4px 12px;font-size:11px;background:var(--primary);color:#fff;border:none;border-radius:4px;cursor:pointer">重新生成智能方案 →</button>`});
      }
      return;
    }

    const stats = catStats[fd.cat];
    if(!stats) return;

    // 动态阈值
    const zScore = (fd.r1 - stats.avgR1) / stats.stdR1;
    if(zScore < -2){
      issues.push(`近1年收益 ${fd.r1>0?'+':''}${fd.r1}%，大幅落后同类均值 ${stats.avgR1.toFixed(1)}%（${Math.abs(zScore).toFixed(1)}σ）`);
      level = 'red';
    } else if(zScore < -1){
      issues.push(`近1年收益 ${fd.r1>0?'+':''}${fd.r1}%，落后同类均值 ${stats.avgR1.toFixed(1)}%`);
      if(level!=='red') level = 'yellow';
    }

    // 结构性亏损
    if(fd.r1 < 0 && fd.r3 < 0){
      issues.push(`近1年(${fd.r1}%)和近3年(${fd.r3}%)均为负收益，呈结构性下行趋势`);
      level = 'red';
    }

    // 当前亏损占最大回撤比例（考虑持有时长：持有超过1年的容忍度更高）
    if(pnlPct !== null && pnlPct < 0 && fd.maxDD > 0){
      const holdDays = h.date ? Math.floor((Date.now() - new Date(h.date).getTime()) / 86400000) : 0;
      const redThreshold = holdDays > 365 ? 100 : 80; // 持有超过1年，容忍度提高到100%
      const yellowThreshold = holdDays > 365 ? 70 : 50;
      const ddRatio = (-pnlPct / fd.maxDD * 100);
      if(ddRatio > redThreshold){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，已达历史最大跌幅(${fd.maxDD}%)的 ${ddRatio.toFixed(0)}%，接近极端水平${holdDays>0?`（已持有${holdDays}天）`:''}`);
        if(level !== 'red') level = 'red';
      } else if(ddRatio > yellowThreshold){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，占历史最大跌幅(${fd.maxDD}%)的 ${ddRatio.toFixed(0)}%${holdDays>0?`（已持有${holdDays}天）`:''}`);
        if(level === 'green') level = 'yellow';
      }
    }

    // 今日大跌（按类别差异化阈值）
    const dropThreshold = {active:-3, qdii:-3, index:-2.5, bond:-1, money:-0.5}[fd.cat] || -2;
    if(todayChg!==null && todayChg < dropThreshold){
      issues.push(`今日下跌 ${todayChg.toFixed(2)}%，关注是否有负面消息驱动`);
      if(level==='green') level='yellow';
    }

    // 类别行情末位且仓位大（注意：这里是"类别级"表现，不是基金在类别内的排名）
    // 联动：若智能推荐最新结论为"加仓/持有/新建仓"，说明算法已综合类别强弱后仍建议保留，跳过此黄警避免矛盾
    if(catRanksCache){
      const catRank = catRanksCache.findIndex(c=>c.cat===fd.cat);
      const recAction = latestPlanActions[h.code];
      const recommendedKeep = recAction && ['buy','buy_more','hold'].includes(recAction);
      if(catRank>=3 && h.value > 5000 && !recommendedKeep){
        issues.push(`「${fd.label}」类别整体表现在 5 类资产中偏弱（第${catRank+1}位/共5类），你在该类别持仓 ¥${h.value.toLocaleString()}，注意权重配比`);
        if(level==='green') level='yellow';
      }
    }

    // 性价比诊断
    const currentScore = scoreF(fd);
    const sameCatFunds = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);

    if(currentScore < 45){
      if(sameCatFunds.length > 0){
        const betterFunds = sameCatFunds.filter(f=>scoreF(f) > currentScore + 10);
        if(betterFunds.length > 0){
          const best = betterFunds.sort((a,b)=>scoreF(b)-scoreF(a))[0];
          issues.push(`综合评分 ${currentScore}分（不及格），同类有更优选择（${best.name} ${scoreF(best)}分），建议换仓`);
          level = 'yellow';
        } else {
          issues.push(`综合评分 ${currentScore}分（不及格），建议关注或考虑换入同类更优基金`);
          if(level==='green') level='yellow';
        }
      } else {
        issues.push(`综合评分 ${currentScore}分（不及格），建议关注基金表现`);
        if(level==='green') level='yellow';
      }
    } else if(sameCatFunds.length > 0){
      const betterFunds = sameCatFunds.filter(f=>scoreF(f) > currentScore + 15);
      if(betterFunds.length > 0){
        const best = betterFunds.sort((a,b)=>scoreF(b)-scoreF(a))[0];
        issues.push(`综合评分 ${currentScore}分，同类有更优选择（${best.name} ${scoreF(best)}分），可考虑换仓`);
        if(level==='green') level='yellow';
      }
    }

    const actionMap = {
      red: '🔴 建议减仓',
      yellow: '🟡 关注观察',
      green: '🟢 继续持有',
    };

    if(issues.length>0){
      const advice = level==='red'
        ? `建议考虑减仓或换入${fd.cat==='active'?'指数基金等':'同类更优基金'}，释放资金重新配置。`
        : '建议持续观察，若1个月内未改善可考虑调仓。';
      holdingAlerts.push({code:h.code,name:h.name,level,
        desc: issues.join('；') + '。' + advice,
        action: actionMap[level], source:'existing'});
    } else {
      holdingOkList.push({code:h.code,name:h.name,level:'green',
        desc:`表现正常。近1年 ${fd.r1>0?'+':''}${fd.r1}%，同类均值 ${stats.avgR1.toFixed(1)}%。${todayChg!==null?`今日 ${todayChg>0?'+':''}${todayChg.toFixed(2)}%。`:''}继续持有。`,
        action:'🟢 持有', source:'existing'});
    }
  });

  // ========== 诊断定投基金（长期视角，宽松标准） ==========
  dcaHoldings.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const nav = navCache[h.code];
    // 非交易日（周末/节假日）的估值数据是上一交易日残留，不应作为"今日"展示
    const todayChg = (nav && typeof isTradingDay === 'function' && isTradingDay()) ? parseFloat(nav.gszzl)||0 : null;
    const pnlPct = h.cost>0 ? (h.value-h.cost)/h.cost*100 : null;
    const pct = totalPortValue > 0 ? h.value / totalPortValue * 100 : 0;
    const issues = [];
    let level = 'green';

    // 定投计划状态提示
    const statusHint = h.paused ? '（已暂停）' : `（每月¥${h.monthly}）`;

    if(!fd){
      // 保护期判断：定投计划加入后4周内，即使移出精选库也给出友好提示而非直接标"建议评估"
      const addedAt = h.addedAt || h.start;
      const weeksSinceAdded = addedAt ? Math.floor((Date.now() - new Date(addedAt).getTime()) / (7 * 86400000)) : 99;
      const inProtection = weeksSinceAdded < 4;
      const libNote = inProtection
        ? `该基金已移出本周精选库（加入定投 ${weeksSinceAdded} 周），可能因评分下滑/经理变更/规模异常被替换。建议在定投专区重新生成方案，评估是否换入同类更优基金。`
        : `该基金不在精选库中，无法进行详细诊断${statusHint}。建议在定投专区重新生成方案，评估是否换入同类更优基金。`;
      if(pnlPct!==null && pnlPct < -25){
        issues.push(`定投亏损 ${pnlPct.toFixed(1)}%，已超过-25%预警线${statusHint}。该基金不在精选库`);
        level = 'red';
      }
      if(issues.length){
        dcaAlerts.push({code:h.code,name:h.name,level, desc:issues.join('；')+'。', action:level==='red'?'🔴 考虑暂停':'🟡 关注', source:'dca'});
      } else {
        dcaOkList.push({code:h.code,name:h.name,level: inProtection ? 'yellow' : 'green',
          desc:`${libNote}${pnlPct!==null?` 当前${pnlPct>=0?'盈利':'亏损'} ${Math.abs(pnlPct).toFixed(1)}%。`:''} ${todayChg!==null?`今日 ${todayChg>0?'+':''}${todayChg.toFixed(2)}%。`:''}`,
          action: inProtection ? '🟡 关注观察' : '🟢 继续定投', source:'dca',
          extraAction: `<button onclick="switchTab(1)" style="margin-top:6px;padding:4px 12px;font-size:11px;background:var(--primary);color:#fff;border:none;border-radius:4px;cursor:pointer">重新生成定投方案 →</button>`});
      }
      return;
    }

    const stats = catStats[fd.cat];
    if(!stats) return;

    // 定投专用：更宽松的动态阈值（Z < -2.5σ 才标红，Z < -1.5σ 才标黄）
    const zScore = (fd.r1 - stats.avgR1) / stats.stdR1;
    if(zScore < -2.5){
      issues.push(`近1年收益 ${fd.r1>0?'+':''}${fd.r1}%，严重落后同类均值 ${stats.avgR1.toFixed(1)}%（${Math.abs(zScore).toFixed(1)}σ）${statusHint}`);
      level = 'red';
    } else if(zScore < -1.5){
      issues.push(`近1年收益 ${fd.r1>0?'+':''}${fd.r1}%，落后同类均值 ${stats.avgR1.toFixed(1)}%${statusHint}`);
      if(level!=='red') level = 'yellow';
    }

    // 定投专用：结构性亏损（r1 < -10% 且 r3 < -15%，比持仓更宽松）
    if(fd.r1 < -10 && fd.r3 < -15){
      issues.push(`近1年(${fd.r1}%)和近3年(${fd.r3}%)均严重亏损，长期趋势不佳${statusHint}`);
      level = 'red';
    }

    // 定投专用：当前亏损占最大回撤比例（阈值提高到100%才标红，70%标黄）
    // 定投在下跌中摊低成本是正常策略，不应过早预警
    if(pnlPct !== null && pnlPct < 0 && fd.maxDD > 0){
      const ddRatio = (-pnlPct / fd.maxDD * 100);
      if(ddRatio > 100){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，已超过历史最大跌幅(${fd.maxDD}%)${statusHint}`);
        if(level !== 'red') level = 'red';
      } else if(ddRatio > 70){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，占历史最大跌幅(${fd.maxDD}%)的 ${ddRatio.toFixed(0)}%${statusHint}`);
        if(level === 'green') level = 'yellow';
      }
    }

    // 定投专用：今日大跌不作为预警（定投就是要在下跌时买入）
    // 只在极端情况（-5%以上）才提示关注
    if(todayChg!==null && todayChg < -5){
      issues.push(`今日大幅下跌 ${todayChg.toFixed(2)}%，建议关注是否有基本面变化再决定是否加仓${statusHint}`);
      // 不改变 level，仅作为信息提示
    }

    // 定投专用：性价比诊断（评分 < 50 才标记问题，比持仓更宽松）
    const currentScore = scoreF(fd);
    const dcaScore = calcDCAScore(fd);
    const sameCatFunds = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);

    if(currentScore < 45){
      const betterFunds = sameCatFunds.filter(f=>scoreF(f) > currentScore + 10);
      if(betterFunds.length > 0){
        const best = betterFunds.sort((a,b)=>scoreF(b)-scoreF(a))[0];
        issues.push(`综合评分 ${currentScore}分（较低），同类有更优选择（${best.name} ${scoreF(best)}分）${statusHint}。定投评分 ${dcaScore}分（定投适配度独立评估，与综合评分维度不同）`);
        level = 'yellow';
      }
    } else if(dcaScore < 60 && sameCatFunds.length > 0){
      // 定投评分不及格，提示但不强制要求换基
      const betterDcaFunds = sameCatFunds.filter(f=>calcDCAScore(f) > dcaScore + 15);
      if(betterDcaFunds.length > 0){
        const best = betterDcaFunds.sort((a,b)=>calcDCAScore(b)-calcDCAScore(a))[0];
        issues.push(`定投评分 ${dcaScore}分（不及格），同类有更适合定投的基金（${best.name} ${calcDCAScore(best)}分）${statusHint}。综合评分 ${currentScore}分`);
        if(level==='green') level='yellow';
      }
    }

    const actionMap = {
      red: '🔴 考虑暂停',
      yellow: '🟡 关注观察',
      green: '🟢 继续定投',
    };

    if(issues.length>0){
      const advice = level==='red'
        ? `定投是长期策略，但该基金长期表现不佳。建议${h.paused?'重新评估是否恢复':'暂停定投'}，或换入同类更优基金。`
        : '定投需要耐心，短期波动是正常的。建议持续观察，若3个月内未改善可考虑调整。';
      dcaAlerts.push({code:h.code,name:h.name,level,
        desc: issues.join('；') + '。' + advice,
        action: actionMap[level], source:'dca'});
    } else {
      dcaOkList.push({code:h.code,name:h.name,level:'green',
        desc:`定投表现良好${statusHint}。近1年 ${fd.r1>0?'+':''}${fd.r1}%，同类均值 ${stats.avgR1.toFixed(1)}%。定投评分 ${dcaScore}分。${todayChg!==null?`今日 ${todayChg>0?'+':''}${todayChg.toFixed(2)}%。`:''}坚持定投。`,
        action:'🟢 继续定投', source:'dca'});
    }
  });

  // 类别集中度预警（独立条目）
  const catAlerts = [];
  // 权益类合计集中度
  if(catConcAlerts.length > 0){
    catConcAlerts.forEach(msg => {
      catAlerts.push({code:'_cat_equity',name:'权益类集中度',level:'yellow', desc:msg, action:'🟡 需分散', source:'category'});
    });
  }
  Object.keys(catConcentration).forEach(cat=>{
    if(cat === 'other') return;
    const catPct = totalPortValue > 0 ? catConcentration[cat] / totalPortValue * 100 : 0;
    if(catPct > 60){
      const catName = CAT_NAMES[cat] || cat;
      catAlerts.push({code:'_cat_'+cat,name:`${catName}类别`,level:'yellow',
        desc:`${catName}类别占总持仓 ${catPct.toFixed(1)}%，超过60%警戒线。建议分散到其他类别。`,
        action:'🟡 需分散', source:'category'});
    }
  });

  // 合并所有诊断结果
  const allAlerts = [...holdingAlerts, ...dcaAlerts, ...catAlerts];
  const allOkList = [...holdingOkList, ...dcaOkList];

  if(!allAlerts.length && !allOkList.length){ wrap.innerHTML=''; return; }

  const redCount = allAlerts.filter(a=>a.level==='red').length;
  const yellowCount = allAlerts.filter(a=>a.level==='yellow').length;
  const greenCount = allOkList.length;
  const headerClass = redCount>0?'':'alert-green';
  const headerIcon = redCount>0?'🔴':yellowCount>0?'🟡':'✅';
  const headerMsg = redCount>0?`发现 ${redCount} 项高风险预警，${yellowCount} 项关注信号`:
    yellowCount>0?`发现 ${yellowCount} 项关注信号，${greenCount} 只表现良好`:`所有 ${greenCount} 只基金表现良好，当前策略合理`;

  const renderItem = (a, showSourceLabel) => {
    const sourceLabel = showSourceLabel && a.source === 'dca' ? '<span style="font-size:10px;padding:2px 6px;background:#e6f7ff;color:#1890ff;border-radius:4px;margin-left:6px">定投</span>' : '';
    return `<div class="health-item">
      <div class="health-dot health-${a.level}"></div>
      <div class="health-fund">
        <div class="health-name">${escHtml(a.name)} <code style="font-size:10px;color:var(--muted)">${escHtml(a.code)}</code>${sourceLabel}</div>
        <div class="health-desc">${escHtml(a.desc)}</div>
        ${a.extraAction || ''}
      </div>
      <div class="health-action" style="color:${a.level==='red'?'var(--danger)':a.level==='yellow'?'var(--warning)':'var(--success)'}">${escHtml(a.action)}</div>
    </div>`;
  };

  const hasIssues = allAlerts.length > 0;

  // 分组渲染：持仓基金 / 定投基金（各自可折叠）
  const holdingRedCount = holdingAlerts.filter(a=>a.level==='red').length;
  const holdingYellowCount = holdingAlerts.filter(a=>a.level==='yellow').length;
  const dcaRedCount = dcaAlerts.filter(a=>a.level==='red').length;
  const dcaYellowCount = dcaAlerts.filter(a=>a.level==='yellow').length;

  const holdingSummary = holdingRedCount>0 ? `${holdingRedCount} 项预警` : holdingYellowCount>0 ? `${holdingYellowCount} 项关注` : `${holdingOkList.length} 只表现良好`;
  const dcaSummary = dcaRedCount>0 ? `${dcaRedCount} 项预警` : dcaYellowCount>0 ? `${dcaYellowCount} 项关注` : `${dcaOkList.length} 只适配良好`;

  let contentHtml = '';

  if(holdingAlerts.length > 0 || holdingOkList.length > 0){
    const holdingHasIssues = holdingAlerts.length > 0;
    contentHtml += `<details class="diag-section" ${holdingHasIssues?'open':''}>
      <summary class="diag-header diag-header-holding">
        <span class="diag-header-left">📊 持仓基金诊断<span class="diag-count">（${holdings.length}只）</span></span>
        <span class="diag-header-right">
          <span class="diag-badge${holdingHasIssues?'':' badge-ok'}">${holdingSummary}</span>
          <span class="diag-chevron">▸</span>
        </span>
      </summary>
      <div>${[...holdingAlerts, ...holdingOkList].map(a => renderItem(a, false)).join('')}</div>
    </details>`;
  }

  if(dcaAlerts.length > 0 || dcaOkList.length > 0){
    const dcaHasIssues = dcaAlerts.length > 0;
    contentHtml += `<details class="diag-section" ${dcaHasIssues?'open':''}>
      <summary class="diag-header diag-header-dca">
        <span class="diag-header-left">📈 定投基金诊断<span class="diag-count">（${dcaHoldings.length}只）</span></span>
        <span class="diag-header-right">
          <span class="diag-badge${dcaHasIssues?'':' badge-ok'}">${dcaSummary}</span>
          <span class="diag-chevron">▸</span>
        </span>
      </summary>
      <div>${[...dcaAlerts, ...dcaOkList].map(a => renderItem(a, false)).join('')}</div>
    </details>`;
  }

  if(catAlerts.length > 0){
    contentHtml += `<details class="diag-section" open>
      <summary class="diag-header diag-header-alloc">
        <span class="diag-header-left">⚖️ 资产配置诊断</span>
        <span class="diag-header-right">
          <span class="diag-badge">${catAlerts.length} 项提示</span>
          <span class="diag-chevron">▸</span>
        </span>
      </summary>
      <div>${catAlerts.map(a => renderItem(a, false)).join('')}</div>
    </details>`;

  }

  // 诊断策略说明
  const strategyHtml = `<details class="diag-section">
    <summary class="diag-header diag-header-info" style="font-size:11px;padding:10px 16px">
      <span class="diag-header-left">💡 持仓基金采用短期视角（严格标准），定投基金采用长期视角（宽松标准）。${Object.keys(navCache).length>0?'已融合实时行情数据':'建议等待净值加载后刷新'}。</span>
      <span class="diag-header-right">
        <span style="color:var(--primary);font-size:11px">诊断策略说明</span>
        <span class="diag-chevron" style="width:18px;height:18px;font-size:10px">▸</span>
      </span>
    </summary>
    <div style="padding:10px 14px;background:#fafafa;font-size:11px;color:#595959;line-height:1.8;border-top:1px dashed #e8e8e8">
      <div style="margin-bottom:8px"><b style="color:#1890ff">📊 持仓基金诊断（短期严格标准）</b></div>
      <div style="padding-left:12px;margin-bottom:10px">
        适用于已买入的基金，侧重<b>短期风险控制与及时止损</b>。<br>
        · 集中度检查：单只基金占总持仓超过 40% 触发预警<br>
        · 同类对比：基于 Z-Score 动态阈值，落后同类 1σ 以上关注，2σ 以上预警<br>
        · 结构性亏损：近1年与近3年均为负收益时标红<br>
        · 回撤监控：当前亏损达历史最大回撤 50%/80% 时逐级预警<br>
        · 今日异动：单日跌幅超过 -2% 触发关注<br>
        · 性价比评分：综合评分（scoreF）不及格且同类有更优选择时建议换仓
      </div>
      <div style="margin-bottom:8px"><b style="color:#389e0d">📈 定投基金诊断（长期宽松标准）</b></div>
      <div style="padding-left:12px;margin-bottom:10px">
        适用于定投计划中的基金，侧重<b>长期趋势与定投适配性</b>。<br>
        · 定投适配度：基于 calcDCAScore 评估波动适度性、长期趋势、管理质量等<br>
        · 长期趋势：近3年收益低于 -15% 时才触发严重预警（定投允许短期下跌摊成本）<br>
        · 回撤容忍：阈值放宽至 70%/100%（定投本身就是下跌买入策略）<br>
        · 同类对比：Z-Score 阈值放宽至 -1.5σ/-2.5σ<br>
        · 今日异动：仅 -5% 以上极端大跌才提示（定投不关注日波动）<br>
        · 定投评分：综合评分与定投专属评分双重参考，推荐更适合定投的替代标的
      </div>
      <div style="margin-bottom:8px"><b style="color:#d48806">⚖️ 资产配置诊断</b></div>
      <div style="padding-left:12px;margin-bottom:10px">
        · 检测某一类别基金占总持仓超过 60% 的集中风险，建议分散配置
      </div>
      <div style="color:#8c8c8c;border-top:1px dashed #e8e8e8;padding-top:6px;margin-top:4px">
        ⏱ 诊断频率：每次刷新净值后自动运行 · 净值数据超过24小时未刷新则暂停诊断 · 数据来源：精选基金库 + 实时行情
      </div>
    </div>
  </details>`;

  wrap.innerHTML=`<details class="card ${headerClass} alert-card" style="cursor:pointer" ${hasIssues?'open':''}>
    <summary style="list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div style="flex:1">
        <div class="alert-card-title">${headerIcon} 持仓健康诊断 · ${holdings.length + dcaHoldings.length} 只基金</div>
        <div style="font-size:12px;color:var(--muted)">${headerMsg}</div>
      </div>
      <span class="toggle-arrow" style="font-size:12px;color:var(--primary);flex-shrink:0"></span>
    </summary>
    <div style="padding:4px 0 8px">
    ${contentHtml}
    ${strategyHtml}
    </div>
  </details>`;
}

// ═══════════════ 初始化（异步：IndexedDB → 渲染） ═══════════════
(async function init(){
  // 0. 加载动态精选库（与后续步骤并行，不阻塞 session 恢复）
  loadCuratedFunds();

  // 1. 从 localStorage 迁移到 IndexedDB（首次）
  try { await FundDB.migrateFromLocalStorage(); } catch(e){ console.warn('迁移失败',e); }

  // 2. 从 IndexedDB 加载数据
  try {
    const data = await FundDB.getAll();
    funds = data.funds || [];
    holdings = data.holdings || [];
    existingHoldings = data.existingHoldings || [];
    dcaPlans = data.dcaPlans || [];
    navCache = data.navCache || {};
    // 如果有缓存的净值数据，设置 navRefreshed 标志
    if(Object.keys(navCache).length > 0){
      navRefreshed = true;
    }
  } catch(e){ console.warn('IndexedDB 加载失败，使用空数据',e); }

  // 3. 渲染
  renderMarketGrid();
  renderAll();
  checkDcaReminder();
  checkHoldingConfirmReminder();
  checkRedeemArrivalReminder();
  document.getElementById('eh-date').valueAsDate=new Date();
  document.getElementById('dp-start').valueAsDate=new Date();

  // 3.1 自动获取净值逻辑已移至 checkAndAutoRefresh()，在云端数据同步完成后执行

  // 3.2 数据迁移：如果旧 holdings 数组有数据，合并到 existingHoldings
  if(holdings && holdings.length){
    let migrated=0;
    holdings.forEach(h=>{
      if(!existingHoldings.some(e=>e.code===h.code)){
        const cost = h.amount || (h.shares*h.cost) || 0;
        const value = h.amount ? (h.amount/h.cost*h.cur) : (h.shares*h.cur) || 0;
        existingHoldings.push({code:h.code,name:h.name,amount:cost,date:h.date||'',status:'confirmed',type:h.type||'股票型',cost:h.cost||1,value:value});
        migrated++;
      }
    });
    if(migrated>0){
      FundDB.set('existingHoldings',existingHoldings);
      console.log(`已迁移 ${migrated} 条持仓记录到 existingHoldings`);
    }
    renderExistingHoldings();
  }

  // 3.5 欢迎卡片初始化检查
  if(localStorage.getItem('_welcomeDismissed')){
    const wc=document.getElementById('welcome-card');
    if(wc) wc.style.display='none';
  }

  // 4. 备份提醒和登录状态恢复统一在 Supabase session 检查后处理
  // （避免 session 异步恢复前 _currentUser 还是 null 导致误弹备份提醒）

  // 4.5 Supabase 登录状态恢复
  if(_supa){
    let _sessionResolved = false;

    // 监听登录状态变化（优先处理，避免 getSession 误判）
    _supa.auth.onAuthStateChange((event, session) => {
      console.log('[Auth] onAuthStateChange:', event, session?.user?.email);

      if(event === 'INITIAL_SESSION'){
        _sessionResolved = true;
        if(session?.user){
          _currentUser = session.user;
          updateAuthUI();
          FundDB.onSync(_debounce(pushToCloud, 2000));
          pullFromCloud().then(async ()=>{
            if(localStorage.getItem('_syncPending')) pushToCloud();
            // 云端数据同步完成后，检查是否需要自动刷新净值
            await checkAndAutoRefresh();
          });
        } else {
          // 只有在 INITIAL_SESSION 确认无 session 时才显示登录弹窗
          setTimeout(()=>{ if(!_currentUser) showAuthModal(); }, 500);
        }
      } else if(event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED'){
        if(session?.user){
          _sessionResolved = true;
          _currentUser = session.user;
          updateAuthUI();
          if(event === 'SIGNED_IN'){
            FundDB.onSync(_debounce(pushToCloud, 2000));
            pullFromCloud().then(async ()=>{
              if(localStorage.getItem('_syncPending')) pushToCloud();
              // 云端数据同步完成后，检查是否需要自动刷新净值
              await checkAndAutoRefresh();
            });
          }
        }
      } else if(event === 'SIGNED_OUT'){
        _currentUser = null;
        updateAuthUI();
      }
    });

    // getSession 作为备用（onAuthStateChange 可能不触发 INITIAL_SESSION）
    setTimeout(()=>{
      if(!_sessionResolved){
        _supa.auth.getSession().then(async ({data:{session}}) => {
          if(_sessionResolved) return;
          _sessionResolved = true;
          if(session?.user){
            _currentUser = session.user;
            updateAuthUI();
            FundDB.onSync(_debounce(pushToCloud, 2000));
            pullFromCloud().then(async ()=>{
              if(localStorage.getItem('_syncPending')) pushToCloud();
              // 云端数据同步完成后，检查是否需要自动刷新净值
              await checkAndAutoRefresh();
            });
          } else {
            setTimeout(()=>{ if(!_currentUser) showAuthModal(); }, 500);
          }
        }).catch(()=>{ if(!_sessionResolved){ _sessionResolved=true; showAuthModal(); } });
      }
    }, 100);
  }

  // 5. iOS 安装引导
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.navigator.standalone === true;
  if(isIOS && !isStandalone && !localStorage.getItem('_iosInstallDismissed')){
    document.getElementById('ios-install-banner').style.display='';
  }

  // 6. 请求通知权限（延迟10秒，不打扰用户）
  requestNotificationPermission();

  // 7. 自动刷新逻辑移到登录状态恢复后执行（确保使用云端最新数据）
  // 见下方 onAuthStateChange 回调中的处理

  // 8. 页面加载后先拉取基金详情，再加载全市场扫描缓存
  //    净值获取推迟到用户点击「生成方案」时触发，避免进入即加载
  refreshFundDetails(false).then(()=>{
    return scanMarketFunds(false).catch(()=>{});
  }).then(()=>{
    // 静默刷新精选列表（不拉取净值）
    renderMarketGrid();
  }).catch(()=>{
    updateDetailStatus('⚠️ 基金详情拉取失败，当前显示为默认数据（可能已过期）', true);
    showGlobalError('⚠️ 基金数据更新失败，当前使用缓存数据，方案可能不够准确', 10000);
  });

  // 9. 每5分钟自动刷新持仓净值（静默模式，仅页面可见时执行）
  setInterval(()=>{
    if(document.hidden) return; // 页面不可见（后台/息屏）时跳过，节省电量和流量
    if(existingHoldings.length === 0) return; // 无持仓时不刷新
    refreshHoldingsNav(false); // 只刷新持仓基金，不显示toast
  }, 5 * 60 * 1000);
  // 页面从后台恢复时立即刷新一次
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden && existingHoldings.length > 0) refreshHoldingsNav(false);
  });
})();

// ═══════════════ 自动刷新检查函数 ═══════════════
async function checkAndAutoRefresh(){
  if(existingHoldings.length === 0){
    console.log('[自动刷新] 无持仓数据，跳过刷新');
    return;
  }

  const lastRefreshTime = await FundDB.get('lastNavRefreshTime') || 0;
  const dataAge = Date.now() - lastRefreshTime;
  const needRefresh = dataAge > 30 * 60 * 1000; // 超过30分钟

  if(needRefresh){
    console.log('[自动刷新] 持仓净值数据已过期，自动刷新中...');
    // 延迟1秒后自动刷新，确保页面已完全加载
    setTimeout(()=>{
      refreshHoldingsNav(false); // 只刷新持仓基金，静默模式，不显示toast
    }, 1000);
  } else {
    console.log('[自动刷新] 净值数据仍然新鲜，无需刷新');
    // 即使不刷新，也要触发一次渲染，确保显示最新数据
    renderExistingHoldings();
    runHealthMonitor();
    renderTodayOverview();
    runSignalEngine();
  }
}

// ═══════════════ 持仓诊断：主动调仓建议 ═══════════════
function renderDiagnostics(){
  // 先渲染"持仓行动建议"区块（基于 myHoldingScheme，独立于换仓建议）
  try { if(typeof renderActionDecisions === 'function') renderActionDecisions(); }
  catch(e){ console.warn('[行动决策] 渲染失败:', e); }

  const wrap = document.getElementById('diagnostics-rebal-wrap');
  const emptyEl = document.getElementById('diag-empty');
  if(!wrap) return;

  // 合并普通持仓 + 定投计划（去重，持仓优先）
  const evalList = [];
  existingHoldings.forEach(h=>{
    const curNav = navCache[h.code] ? parseFloat(navCache[h.code].gsz)||1 : 1;
    const cost = h.amount || h.value || 0;
    const value = h.amount ? (h.amount / (h.cost||curNav) * curNav) : (h.value||0);
    evalList.push({ code:h.code, name:h.name, value, cost, source:'existing', paused:false, date:h.date });
  });
  (typeof dcaPlans !== 'undefined' ? dcaPlans : []).forEach(d=>{
    if(evalList.some(x=>x.code===d.code)) return; // 已在持仓中
    if(!d.curval || d.curval <= 0) return;
    const executedCount = d.execLog ? Object.keys(d.execLog).filter(k => d.execLog[k]).length : 0;
    let cost;
    if(executedCount > 0){
      cost = executedCount * d.monthly;
    } else {
      const months = d.start ? Math.max(0, Math.floor((new Date()-new Date(d.start))/30/86400000)) : 0;
      cost = d.monthly * months;
    }
    evalList.push({ code:d.code, name:d.name, value:d.curval, cost, source:'dca', paused:d.paused||false, monthly:d.monthly, date:d.start });
  });

  if(!evalList.length){
    wrap.innerHTML = '';
    if(emptyEl) emptyEl.style.display = '';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';

  // 优先使用全市场基准（与 scoreF 的 _catBench 保持一致）
  const catStats = {};
  ['active','index','bond','money','qdii'].forEach(cat=>{
    if(_catBench && _catBench[cat]){
      catStats[cat] = { avgR1: _catBench[cat].avgR1, stdR1: _catBench[cat].stdR1, count: _catBench[cat].count||0 };
    } else {
      const fs=CURATED_FUNDS.filter(f=>f.cat===cat);
      if(!fs.length) return;
      const avgR1 = fs.reduce((s,f)=>s+f.r1,0)/fs.length;
      const stdR1 = Math.sqrt(fs.reduce((s,f)=>s+(f.r1-avgR1)**2,0)/fs.length)||1;
      catStats[cat] = { avgR1, stdR1, count:fs.length };
    }
  });

  const suggestions = [];
  evalList.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    if(!fd) return;
    const currentScore = scoreF(fd);
    const sameCat = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);
    const pnlPct = h.cost>0 ? (h.value-h.cost)/h.cost*100 : null;

    // 与健康监控保持一致的"问题定投/持仓"判定
    const stats = catStats[fd.cat];
    const zScore = stats ? (fd.r1 - stats.avgR1) / stats.stdR1 : 0;
    const isStructuralLoss = fd.r1 < -10 && fd.r3 < -15;
    const isSeverelyLagging = stats && zScore < -2.5;
    const ddOverflow = fd.r1 < 0 && fd.maxDD > 0 && (-fd.r1 / fd.maxDD * 100) > 80;
    const isProblem = isStructuralLoss || isSeverelyLagging || ddOverflow || currentScore < 45;

    // 找同类最优
    const sortedSameCat = sameCat.slice().sort((a,b)=>scoreF(b)-scoreF(a));
    const betterThan15 = sortedSameCat.filter(f=>scoreF(f) > currentScore + 15);

    let best = null, reason = '';
    if(isProblem && betterThan15.length){
      best = betterThan15[0];
      reason = 'score15';
    } else if(isProblem && sortedSameCat.length){
      // 标红但同类没有高15分更优 → 仍取同类最高作为候选，避免与健康监控矛盾
      const topCandidate = sortedSameCat[0];
      if(scoreF(topCandidate) > currentScore){
        best = topCandidate;
        reason = 'problem'; // 基金本身有问题，同类相对更优但差距不大
      } else {
        reason = 'noAlt'; // 本基金就是同类第一或并列最高
      }
    }

    if(!best && reason !== 'noAlt') return;
    // 换仓成本评估：复用智能方案的 calculateRebalanceCost，消除两模块矛盾
    let costInfo = null;
    if(best && typeof calculateRebalanceCost === 'function'){
      const holdingDays = h.date ? Math.floor((Date.now() - new Date(h.date).getTime()) / 86400000) : 365;
      costInfo = calculateRebalanceCost(fd, best, holdingDays, h.value);
    }
    suggestions.push({
      holding:h, fd, currentScore,
      best, bestScore: best ? scoreF(best) : null,
      pnlPct, source:h.source, reason, isProblem,
      costInfo
    });
  });

  // 拆分：需要换仓的（有 best）和"本基金已是同类最优但表现不佳"的
  const rebalList = suggestions.filter(s=>s.best);
  const noAltList = suggestions.filter(s=>!s.best && s.reason === 'noAlt');

  if(!rebalList.length && !noAltList.length){
    wrap.innerHTML = `<div class="card"><div class="card-title"><span class="icon icon-blue">🔄</span>调仓建议</div><div style="padding:16px 0;text-align:center;color:var(--muted);font-size:13px">✅ 当前持仓与定投均为同类最优选择，无需调仓</div></div>`;
    return;
  }

  const sourceBadge = src => src === 'dca'
    ? '<span style="font-size:10px;padding:2px 6px;background:#e6f7ff;color:#1890ff;border-radius:4px;margin-left:6px">定投</span>'
    : '<span style="font-size:10px;padding:2px 6px;background:#f0f5ff;color:#2f54eb;border-radius:4px;margin-left:6px">持仓</span>';

  const rows = rebalList.map(s=>{
    const pnlStr = s.pnlPct!==null ? `${s.source==='dca'?'定投':'持仓'}${s.pnlPct>=0?'+':''}${s.pnlPct.toFixed(1)}%` : '';
    const redeemTip = s.pnlPct!==null && s.pnlPct < 0 ? '（当前亏损，换仓需承担浮亏）' : '';
    // 根据换仓成本评估结果区分展示
    const costNotWorth = s.costInfo && !s.costInfo.worthIt;
    let actionLabel, costNote = '';
    if(costNotWorth){
      // 换仓成本不划算：降级为"观察"，附带成本数据
      actionLabel = '👀 暂不建议换';
      const costPct = (s.costInfo.totalCostRate * 100).toFixed(2);
      const breakEven = s.costInfo.breakEvenYears < 99 ? `${s.costInfo.breakEvenYears.toFixed(1)}年` : '极长';
      costNote = `<br>💸 <span style="color:#d46b08">换仓成本 ${costPct}%，需${breakEven}回本，当前不划算。建议持有满2年（免赎回费）后再考虑。</span>`;
    } else {
      actionLabel = s.source === 'dca'
        ? (s.reason === 'problem' ? '⏸️ 暂停并换入' : '🔄 换入定投')
        : '🔄 建议换仓';
      if(s.costInfo && s.costInfo.worthIt){
        const costPct = (s.costInfo.totalCostRate * 100).toFixed(2);
        const breakEven = s.costInfo.breakEvenYears.toFixed(1);
        costNote = `<br>💰 换仓成本 ${costPct}%，预计${breakEven}年回本，换仓划算。`;
      }
    }
    const gapNote = s.reason === 'problem'
      ? `当前基金近期表现不佳（${s.isProblem?'严重落后同类/结构性亏损':'评分偏低'}），同类相对更优`
      : `评分差 +${s.bestScore-s.currentScore}分`;
    const actionStyle = costNotWorth
      ? 'color:var(--muted);background:#f5f5f5;border:1px solid #d9d9d9'
      : 'color:#d48806;background:#fff7e6;border:1px solid #ffd591';
    return `<div style="padding:14px 16px;border-bottom:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600;color:#cf1322;padding:4px 10px;background:#fff1f0;border:1px solid #ffccc7;border-radius:6px">${escHtml(s.fd.name)} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.currentScore}分</span></span>${sourceBadge(s.source)}
        <span style="color:var(--muted);font-size:14px">→</span>
        <span style="font-size:13px;font-weight:600;color:#389e0d;padding:4px 10px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:6px">${escHtml(s.best.name)} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.bestScore}分</span></span>
        <span style="margin-left:auto;font-size:12px;font-weight:600;${actionStyle};padding:3px 10px;border-radius:6px;white-space:nowrap">${actionLabel}</span>
      </div>
      <div style="font-size:12px;color:#595959;line-height:1.6;padding:8px 10px;background:#fafafa;border-radius:6px">
        ${gapNote} · ${pnlStr}${redeemTip}${costNote}<br>
        📈 ${escHtml(s.best.name)}：近1年${s.best.r1>0?'+':''}${s.best.r1}%，近3年${s.best.r3>0?'+':''}${s.best.r3}%，经理任期${s.best.mgrYears}年
      </div>
    </div>`;
  }).join('');

  // "同类已是最优但本基金表现不佳"的提示（避免与健康监控矛盾的关键）
  const noAltRows = noAltList.map(s=>{
    const pnlStr = s.pnlPct!==null ? `${s.source==='dca'?'定投':'持仓'}${s.pnlPct>=0?'+':''}${s.pnlPct.toFixed(1)}%` : '';
    const advice = s.source === 'dca'
      ? '建议暂停定投并观察，或转投其他类别（如债券/货币基金）'
      : '建议减仓或转投其他类别，释放资金重新配置';
    return `<div style="padding:14px 16px;border-bottom:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600;color:#cf1322;padding:4px 10px;background:#fff1f0;border:1px solid #ffccc7;border-radius:6px">${escHtml(s.fd.name)} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.currentScore}分</span></span>${sourceBadge(s.source)}
        <span style="margin-left:auto;font-size:12px;font-weight:500;color:var(--muted);padding:3px 10px;background:#f5f5f5;border:1px solid #d9d9d9;border-radius:6px;white-space:nowrap">🔍 持仓</span>
      </div>
      <div style="font-size:12px;color:#595959;line-height:1.6;padding:8px 10px;background:#fafafa;border-radius:6px">
        ⚠️ 本基金近期表现不佳，但同类精选库内暂无显著更优选择 · ${pnlStr}<br>
        💡 ${advice}
      </div>
    </div>`;
  }).join('');

  const totalCount = rebalList.length + noAltList.length;
  const headerHint = rebalList.length && noAltList.length
    ? `${rebalList.length} 条换仓建议 · ${noAltList.length} 条同类无更优提示`
    : rebalList.length
      ? '同类基金中有评分更优的选择'
      : '本基金近期表现不佳，但同类暂无显著更优';

  wrap.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div class="card-title" style="margin:0"><span class="icon icon-red">🔄</span>主动调仓建议 · ${totalCount} 条</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">${headerHint}</div>
    </div>
    <div style="padding:10px 14px;background:#fff1f0;border-bottom:1px solid var(--border);font-size:12px;color:#a8071a;line-height:1.7">
      📊 <b>判断维度</b>：对比当前持仓评分 vs 同类最优基金评分，评分差 &gt;15 分且换仓成本划算时建议换仓（基于选基质量）。与上方"持仓行动建议"（基于仓位偏离）互补。
    </div>
    ${rows}
    ${noAltRows}
    <div style="padding:10px 14px;font-size:11px;color:var(--muted);background:#fafafa">⚠️ 已计算换仓成本（赎回费+申购费+回本期），标注"暂不建议换"的基金持有满2年后再评估。定投基金暂停后建议评估是否转投其他类别。</div>
  </div>`;
}

// ═══════════════ 持仓诊断：市场行情概览 ═══════════════
function renderDiagMarket(){
  const catRanks = analyzeCategoryPerf();
  // 复用行情表格渲染，但输出到诊断Tab的独立容器
  const tableEl = document.getElementById('diag-market-table');
  const mobileEl = document.getElementById('diag-market-mobile');
  const summaryEl = document.getElementById('diag-market-summary');
  if(!tableEl) return;

  // 判断是否有实时净值
  const chgAvailable = Object.keys(navCache).length > 0;

  // 桌面表格
  tableEl.innerHTML = `<thead><tr><th>类别</th><th>今日均涨跌</th><th>近1年均收益</th><th>近3年均收益</th><th>性价比(Calmar)</th><th>趋势</th></tr></thead>
  <tbody>${catRanks.map((c,i)=>{
    const chgText = chgAvailable ? `<span class="${c.avgChg>=0?'up':'down'}">${c.avgChg>=0?'+':''}${c.avgChg.toFixed(2)}%</span>` : '<span style="color:var(--muted)">—</span>';
    const trendBg = c.catTrend>=2?'background:#fff1f0;color:#cf1322;border:1px solid #ffccc7':c.catTrend>=0?'background:#e6f4ff;color:#1677ff;border:1px solid #91caff':'background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f';
    const trendText = c.catTrend>=2?'🔥 强势':c.catTrend>=0?'➡️ 平稳':'❄️ 弱势';
    const rowBg = i%2===0?'':'background:#f8f9fc';
    return `<tr style="${rowBg}"><td><b>${i+1}. ${escHtml(c.name)}</b></td><td>${chgText}</td>
      <td class="${c.avgR1>=0?'up':'down'}" style="font-weight:600">${c.avgR1>=0?'+':''}${c.avgR1.toFixed(1)}%</td>
      <td class="${c.avgR3>=0?'up':'down'}" style="font-weight:600">${c.avgR3>=0?'+':''}${c.avgR3.toFixed(1)}%</td>
      <td style="font-weight:600">${c.avgCalmar.toFixed(2)}</td>
      <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;white-space:nowrap;${trendBg}">${trendText}</span></td></tr>`;
  }).join('')}</tbody>`;

  // 移动端卡片
  if(mobileEl){
    const isMobile = window.innerWidth < 640;
    mobileEl.style.display = isMobile ? '' : 'none';
    tableEl.closest('.table-wrap').style.display = isMobile ? 'none' : '';
    if(isMobile){
      mobileEl.innerHTML = catRanks.map((c,i)=>{
        const chgText = chgAvailable ? `<span class="${c.avgChg>=0?'up':'down'}">${c.avgChg>=0?'+':''}${c.avgChg.toFixed(2)}%</span>` : '—';
        return `<div class="market-card">
          <div class="market-card-row"><span style="font-size:15px;font-weight:700">${i+1}. ${escHtml(c.name)}</span>${chgText}</div>
          <div class="market-card-row" style="margin-top:8px">
            <div><span class="market-card-label">近1年均收益</span><div class="market-card-val ${c.avgR1>=0?'up':'down'}">${c.avgR1>=0?'+':''}${c.avgR1.toFixed(1)}%</div></div>
            <div><span class="market-card-label">性价比</span><div class="market-card-val">${c.avgCalmar.toFixed(2)}</div></div>
            <div><span class="market-card-label">趋势</span><div style="font-size:13px">${c.catTrend>=2?'🔥强势':c.catTrend>=0?'➡️平稳':'❄️弱势'}</div></div>
          </div>
        </div>`;
      }).join('');
    }
  }

  if(summaryEl) summaryEl.innerHTML = chgAvailable
    ? `📊 数据更新于 ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}，基于精选库实时净值计算 · <span style="color:var(--muted)">性价比 = 年均收益 ÷ 最大回撤，越高越好</span>`
    : '<span style="color:#d48806">⚠️ 净值数据未加载，今日涨跌暂不可用。净值刷新后自动更新。</span>';
}

// ═══════════════ 新手引导 ═══════════════

// ═══════════════ 持仓诊断：行动决策层（加/减仓/首次买入/清仓评估 + 冷静期）═══════════════
// 数据流：myHoldingScheme (localStorage) → 对比 existingHoldings+dcaPlans → decisions
//        每次渲染更新 _actionHistory，按交易日去重，满足阈值 confirmedDays 才从"观察中"升级为正式建议
// 阈值设计：加仓 3 天（避免追高）、减仓/换仓 2 天、风险信号 0 天（保命）

const ACTION_TOL = {
  money:  { pct: 0.10, abs: 300 },
  bond:   { pct: 0.10, abs: 500 },
  index:  { pct: 0.15, abs: 800 },
  active: { pct: 0.20, abs: 800 },
  qdii:   { pct: 0.20, abs: 800 }
};
const MIN_ACTION_AMT = 500;              // 低于此金额建议一律降级为"持有"
const STALE_TRADING_DAYS = 10;           // 超过 10 天无触发 → 清零历史（交易日近似 2 周）
const CONFIRM_DAYS = {
  risk:         0,   // 风险信号立即触发
  swap:         2,
  discontinued: 0,   // 基金已移出白名单 → 立即
  decrease:     2,
  evaluate:     0,   // 状态描述，不设冷静期
  increase:     3,
  init:         3,
  'hold-oop':   0,
  hold:         0
};
const ACTION_PRIORITY = { risk:9, swap:8, discontinued:7, decrease:6, evaluate:5, increase:4, init:3, 'hold-oop':2, hold:1 };

function getLatestTradingDay(){
  // 从 navCache 中取 jzrq 最大值（ISO 日期字符串可直接字符串比较）
  let maxDate = '';
  try {
    Object.values(navCache || {}).forEach(nav => {
      if(!nav) return;
      const d = nav.jzrq || (nav.gztime ? nav.gztime.slice(0,10) : '');
      if(d && d > maxDate) maxDate = d;
    });
  } catch(_){}
  if(maxDate) return maxDate;
  // fallback：当前日期往前找最近的交易日
  const d = new Date();
  while(typeof isCNTradingDay === 'function' && !isCNTradingDay(d)) d.setDate(d.getDate()-1);
  return d.toISOString().slice(0,10);
}

function _loadActionHistory(){
  try { return JSON.parse(localStorage.getItem('_actionHistory') || '{}'); }
  catch(e){ try{ localStorage.removeItem('_actionHistory'); }catch(_){}; return {}; }
}
function _saveActionHistory(hist){
  try { localStorage.setItem('_actionHistory', JSON.stringify(hist)); }
  catch(e){ console.warn('[行动决策] 保存冷静期历史失败:', e); }
}
function resetActionHistoryFor(code){
  const hist = _loadActionHistory();
  if(hist[code]){ delete hist[code]; _saveActionHistory(hist); }
}

// 计算两个 ISO 日期间的自然日差（用于"超过 N 交易日未触发 → 清零"的近似判断）
function _daysBetween(d1, d2){
  if(!d1 || !d2) return 0;
  const t1 = new Date(d1).getTime(), t2 = new Date(d2).getTime();
  return Math.floor(Math.abs(t2 - t1) / 86400000);
}

// 冷静期确认：更新 _actionHistory[code]，返回 { confirmed, confirmedDays, required }
function confirmActionBySession(code, action, latestTradeDate){
  const required = CONFIRM_DAYS[action] || 0;
  if(required === 0){
    return { confirmed: true, confirmedDays: 0, required: 0 };
  }
  const hist = _loadActionHistory();
  let entry = hist[code];

  // action 变化 或 超 10 天未触发 → 重置
  const staleDays = entry && entry.lastTriggerDate ? _daysBetween(entry.lastTriggerDate, latestTradeDate) : 999;
  if(!entry || entry.action !== action || staleDays > STALE_TRADING_DAYS * 1.5){
    entry = {
      action,
      firstTriggerDate: latestTradeDate,
      lastTriggerDate: latestTradeDate,
      triggerDates: [latestTradeDate]
    };
  } else if(!entry.triggerDates.includes(latestTradeDate)){
    // 新交易日首次触发 → push（同一天多次打开不推进）
    entry.triggerDates.push(latestTradeDate);
    entry.lastTriggerDate = latestTradeDate;
  }

  const confirmedDays = entry.triggerDates.length;
  entry.confirmed = confirmedDays >= required;
  hist[code] = entry;
  _saveActionHistory(hist);

  return { confirmed: entry.confirmed, confirmedDays, required };
}

// 清理：decision 消失或变成 hold 时清除对应 code 的历史
function _gcActionHistory(activeCodes){
  const hist = _loadActionHistory();
  let changed = false;
  Object.keys(hist).forEach(code => {
    if(!activeCodes.has(code)){
      delete hist[code];
      changed = true;
    }
  });
  if(changed) _saveActionHistory(hist);
}

// 构建 code → {currentAmt, source, value} 的持仓映射
function _buildHoldingMap(){
  const map = {};
  (typeof existingHoldings !== 'undefined' ? existingHoldings : []).forEach(h => {
    const amt = h.amount || h.value || 0;
    if(!map[h.code]){
      map[h.code] = { currentAmt: amt, value: h.value || amt, source: 'existing', date: h.date, name: h.name };
    } else {
      map[h.code].currentAmt += amt;
      map[h.code].value += (h.value || amt);
    }
  });
  (typeof dcaPlans !== 'undefined' ? dcaPlans : []).forEach(d => {
    if(map[d.code]) return;
    if(!d.curval || d.curval <= 0) return;
    const executedCount = d.execLog ? Object.keys(d.execLog).filter(k => d.execLog[k]).length : 0;
    const cost = executedCount > 0 ? executedCount * d.monthly
      : (d.start ? Math.max(0, Math.floor((Date.now()-new Date(d.start).getTime())/30/86400000)) * d.monthly : 0);
    map[d.code] = { currentAmt: cost, value: d.curval, source: 'dca', date: d.start, name: d.name };
  });
  return map;
}

// 从 _currentSignals 提取当前有危险/警告的 code（与信号引擎联动，风险信号覆盖行动决策）
function _getRiskAlertCodes(){
  const set = new Set();
  try {
    const sigs = (typeof window !== 'undefined' && window._currentSignals) ? window._currentSignals : [];
    sigs.forEach(s => {
      if(s.type === 'danger' || (s.type === 'warning' && s.priority === 0)){
        if(s.code) set.add(s.code);
      }
    });
  } catch(_){}
  return set;
}

// 从 lastRebalancePlan 提取即将被换掉的 code（避免与换仓建议重复提示"减仓"）
// 核心：基于 scheme + 持仓 + 信号，生成 decisions
function computeActionDecisions(){
  const scheme = (typeof loadMyHoldingScheme === 'function') ? loadMyHoldingScheme() : null;
  if(!scheme) return { hasScheme: false, decisions: [], scheme: null, latestTradeDate: getLatestTradingDay() };

  const holdingMap = _buildHoldingMap();
  const riskCodes = _getRiskAlertCodes();
  const latestTradeDate = getLatestTradingDay();

  // 构建目标映射
  const targetMap = {};
  (scheme.picks || []).forEach(p => { targetMap[p.code] = p; });

  const decisions = [];
  const allCodes = new Set([...Object.keys(targetMap), ...Object.keys(holdingMap)]);

  allCodes.forEach(code => {
    const target = targetMap[code];
    const held = holdingMap[code];
    const fd = (typeof CURATED_FUNDS !== 'undefined') ? CURATED_FUNDS.find(f => f.code === code) : null;
    const cat = target ? target.cat : (fd ? fd.cat : 'active');
    const tol = ACTION_TOL[cat] || ACTION_TOL.active;
    const targetAmt = target ? (target.amt || 0) : 0;
    const currentAmt = held ? (held.currentAmt || 0) : 0;
    const currentValue = held ? (held.value || currentAmt) : 0;
    const delta = targetAmt - currentAmt; // 正=需要加仓，负=需要减仓
    const name = target ? target.name : (held ? held.name : (fd ? fd.name : code));

    let action = 'hold';
    let reason = '';

    if(!target && held){
      // 方案外持仓
      const score = fd ? (typeof scoreF === 'function' ? scoreF(fd) : 60) : 0;
      if(!fd){
        action = 'evaluate';
        reason = '已不在精选基金库，建议评估是否清仓';
      } else if(score >= 60 && !riskCodes.has(code)){
        action = 'hold-oop';
        reason = `方案外持有，评分 ${score} 尚可，可保留观察`;
      } else {
        action = 'evaluate';
        reason = `方案外持有，评分 ${score}${score<60?'偏低':''}，建议评估是否清仓或纳入方案`;
      }
    } else if(target && !held){
      // 方案内、未建仓
      if(!fd){
        action = 'discontinued';
        reason = '方案中该基金已移出精选库，建议重新生成方案';
      } else if(targetAmt >= MIN_ACTION_AMT){
        action = 'init';
        reason = `方案目标 ¥${targetAmt.toLocaleString()}，尚未建仓`;
      } else {
        action = 'hold';
        reason = '目标金额过小，暂不建议建仓';
      }
    } else if(target && held){
      // 方案内、有持仓 → 对比差值
      if(!fd){
        action = 'discontinued';
        reason = '该基金已移出精选库，建议清仓并重新生成方案';
      } else {
        const absDelta = Math.abs(delta);
        const pctDelta = targetAmt > 0 ? absDelta / targetAmt : 0;
        const triggerTol = pctDelta > tol.pct && absDelta > tol.abs && absDelta >= MIN_ACTION_AMT;
        if(triggerTol && delta > 0){
          action = 'increase';
          reason = `仓位偏低：目标 ¥${targetAmt.toLocaleString()}，当前 ¥${currentAmt.toLocaleString()}（偏低 ${(pctDelta*100).toFixed(0)}%）`;
        } else if(triggerTol && delta < 0){
          action = 'decrease';
          reason = `仓位偏高：目标 ¥${targetAmt.toLocaleString()}，当前 ¥${currentAmt.toLocaleString()}（偏高 ${(pctDelta*100).toFixed(0)}%）`;
        } else {
          action = 'hold';
          reason = `仓位在容忍区间内（目标 ¥${targetAmt.toLocaleString()} ± ${(tol.pct*100).toFixed(0)}%）`;
        }
      }
    }

    // 风险信号覆盖
    if(riskCodes.has(code) && action !== 'discontinued'){
      action = 'risk';
      reason = '触发风险信号（见上方"持仓健康诊断"或顶部智能监控），请优先处理风险';
    }

    decisions.push({
      code, name, cat, action, reason,
      targetAmt, currentAmt, currentValue, delta: Math.abs(delta),
      source: held ? held.source : null,
      score: fd && typeof scoreF === 'function' ? scoreF(fd) : null
    });
  });

  // 冷静期确认
  decisions.forEach(d => {
    const r = confirmActionBySession(d.code, d.action, latestTradeDate);
    d.confirmed = r.confirmed;
    d.confirmedDays = r.confirmedDays;
    d.requiredDays = r.required;
  });

  // 清理 _actionHistory 中已失效的 code
  _gcActionHistory(new Set(decisions.filter(d => d.action !== 'hold' && d.action !== 'hold-oop').map(d => d.code)));

  // 排序：优先级高在前；同优先级内 confirmed 在前，delta 大在前
  decisions.sort((a, b) => {
    const pa = ACTION_PRIORITY[a.action] || 0, pb = ACTION_PRIORITY[b.action] || 0;
    if(pa !== pb) return pb - pa;
    if(a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    return b.delta - a.delta;
  });

  return { hasScheme: true, scheme, decisions, latestTradeDate };
}

// 渲染"持仓行动建议"区块到 #action-decisions-wrap
function renderActionDecisions(){
  const wrap = document.getElementById('action-decisions-wrap');
  if(!wrap) return;

  // 净值过期守卫：与 runSignalEngine 一致
  const lastRefreshTime = localStorage.getItem('lastNavRefreshTime');
  if(lastRefreshTime && (Date.now() - parseInt(lastRefreshTime)) > 24*60*60*1000){
    wrap.innerHTML = `<div class="card"><div class="card-title"><span class="icon icon-orange">🎯</span>持仓行动建议</div><div style="padding:10px 0;color:var(--muted);font-size:13px">⚠️ 净值数据已过期，请先刷新净值后再查看行动建议。</div></div>`;
    return;
  }

  const { hasScheme, scheme, decisions, latestTradeDate } = computeActionDecisions();

  if(!hasScheme){
    wrap.innerHTML = `<div class="card">
      <div class="card-title"><span class="icon icon-blue">🎯</span>持仓行动建议</div>
      <div style="padding:14px;background:#f0f5ff;border-radius:6px;font-size:13px;color:#1d39c4;line-height:1.8">
        💡 还没有保存"我的持有方案"。<br>
        请先到「🎯 智能方案」tab 生成方案并点击 <b>💾 保存为我的方案</b>，本模块将基于该方案对比当前持仓，给出具体的加仓/减仓/首次买入建议。
      </div>
      <div style="text-align:center;margin-top:12px">
        <button class="btn btn-primary btn-sm" onclick="switchTab(0)" style="padding:8px 20px">前往智能方案 →</button>
      </div>
    </div>`;
    return;
  }

  if(!decisions.length){
    wrap.innerHTML = `<div class="card"><div class="card-title"><span class="icon icon-green">🎯</span>持仓行动建议</div><div style="padding:14px 0;color:var(--muted);font-size:13px;text-align:center">✅ 当前持仓与方案目标一致，无需调整</div></div>`;
    return;
  }

  // 方案过期判断（同 portfolio.js，行动决策层展示时一并提示）
  const ageDays = Math.floor((Date.now() - scheme.savedAt) / 86400000);
  const schemeStaleTag = ageDays > 30 ? `<span style="font-size:11px;color:#ad6800;background:#fffbe6;padding:2px 6px;border-radius:4px;margin-left:6px">方案 ${ageDays} 天前保存</span>` : '';

  // 汇总统计
  const stat = { increase:0, decrease:0, init:0, risk:0, swap:0, evaluate:0, discontinued:0, 'hold-oop':0, hold:0 };
  let addAmt = 0, reduceAmt = 0, initAmt = 0;
  decisions.forEach(d => {
    stat[d.action] = (stat[d.action]||0) + 1;
    if(d.confirmed){
      if(d.action === 'increase') addAmt += d.delta;
      else if(d.action === 'decrease') reduceAmt += d.delta;
      else if(d.action === 'init') initAmt += d.targetAmt;
    }
  });
  const summaryParts = [];
  if(stat.risk) summaryParts.push(`<span style="color:#cf1322;font-weight:600">🔴 紧急 ${stat.risk} 笔</span>`);
  if(addAmt) summaryParts.push(`<span style="color:#389e0d">🟢 加仓 ${stat.increase} 笔 ¥${addAmt.toLocaleString()}</span>`);
  if(reduceAmt) summaryParts.push(`<span style="color:#d46b08">🟠 减仓 ${stat.decrease} 笔 ¥${reduceAmt.toLocaleString()}</span>`);
  if(initAmt) summaryParts.push(`<span style="color:#1890ff">✨ 首次买入 ${stat.init} 笔 ¥${initAmt.toLocaleString()}</span>`);
  const watchCount = decisions.filter(d => !d.confirmed && (d.action==='increase'||d.action==='decrease'||d.action==='init')).length;
  if(watchCount) summaryParts.push(`<span style="color:var(--muted)">🟡 观察 ${watchCount} 笔</span>`);
  if(stat.evaluate) summaryParts.push(`<span style="color:#cf1322">⚠️ 评估清仓 ${stat.evaluate} 笔</span>`);
  if(stat['hold-oop']) summaryParts.push(`<span style="color:var(--muted)">📎 方案外 ${stat['hold-oop']} 笔</span>`);

  // 渲染行
  const actionLabel = (d) => {
    switch(d.action){
      case 'risk': return { icon: '🔴', text: '紧急处理', color: '#cf1322', bg: '#fff1f0', border: '#ffccc7' };
      case 'swap': return { icon: '🔄', text: '建议换仓', color: '#d48806', bg: '#fff7e6', border: '#ffd591' };
      case 'discontinued': return { icon: '⛔', text: '建议清仓', color: '#cf1322', bg: '#fff1f0', border: '#ffccc7' };
      case 'increase':
        return d.confirmed
          ? { icon: '🟢', text: `建议加仓 ¥${d.delta.toLocaleString()}`, color: '#389e0d', bg: '#f6ffed', border: '#b7eb8f' }
          : { icon: '🟡', text: `观察中 ${d.confirmedDays}/${d.requiredDays} 交易日`, color: '#ad6800', bg: '#fffbe6', border: '#ffe58f' };
      case 'decrease':
        return d.confirmed
          ? { icon: '🟠', text: `建议减仓 ¥${d.delta.toLocaleString()}`, color: '#d46b08', bg: '#fff7e6', border: '#ffd591' }
          : { icon: '🟡', text: `观察中 ${d.confirmedDays}/${d.requiredDays} 交易日`, color: '#ad6800', bg: '#fffbe6', border: '#ffe58f' };
      case 'init':
        return d.confirmed
          ? { icon: '✨', text: `建议首次买入 ¥${d.targetAmt.toLocaleString()}`, color: '#1890ff', bg: '#e6f7ff', border: '#91d5ff' }
          : { icon: '🟡', text: `观察中 ${d.confirmedDays}/${d.requiredDays} 交易日`, color: '#ad6800', bg: '#fffbe6', border: '#ffe58f' };
      case 'evaluate': return { icon: '⚠️', text: '建议评估', color: '#cf1322', bg: '#fff1f0', border: '#ffccc7' };
      case 'hold-oop': return { icon: '📎', text: '方案外持有', color: '#595959', bg: '#f5f5f5', border: '#d9d9d9' };
      default: return { icon: '✓', text: '持有', color: '#8c8c8c', bg: '#fafafa', border: '#f0f0f0' };
    }
  };

  // 只渲染非 hold 的条目（hold 是合理状态，省略能让视觉更清爽）
  const visibleDecisions = decisions.filter(d => d.action !== 'hold');
  const rows = visibleDecisions.map(d => {
    const lab = actionLabel(d);
    const catNames = { active:'主动', index:'指数', bond:'债券', money:'货币', qdii:'QDII' };
    const catTag = `<span style="font-size:10px;padding:2px 6px;background:#f0f5ff;color:#2f54eb;border-radius:4px;margin-left:6px">${catNames[d.cat]||d.cat}</span>`;
    const srcTag = d.source === 'dca' ? '<span style="font-size:10px;padding:2px 6px;background:#e6f7ff;color:#1890ff;border-radius:4px;margin-left:4px">定投</span>' : '';
    const scoreTag = d.score !== null ? `<span style="font-size:11px;color:var(--muted);margin-left:4px">评分 ${d.score}</span>` : '';
    const staleNote = ageDays > 30 ? ` <span style="color:#ad6800;font-size:11px">(基于 ${ageDays} 天前方案)</span>` : '';
    return `<div style="padding:12px 14px;border-bottom:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600">${escHtml(d.name)}</span>${catTag}${srcTag}${scoreTag}
        <span style="margin-left:auto;font-size:12px;font-weight:600;color:${lab.color};background:${lab.bg};border:1px solid ${lab.border};padding:3px 10px;border-radius:6px;white-space:nowrap">${lab.icon} ${lab.text}</span>
      </div>
      <div style="font-size:12px;color:#595959;line-height:1.6;padding:6px 10px;background:#fafafa;border-radius:6px">
        ${escHtml(d.reason)}${staleNote}
      </div>
    </div>`;
  }).join('');

  wrap.innerHTML = `<details class="card" style="padding:0;overflow:hidden" open>
    <summary style="padding:14px 16px;border-bottom:1px solid var(--border);cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px">
      <div style="flex:1">
        <div class="card-title" style="margin:0"><span class="icon icon-orange">🎯</span>持仓行动建议 · ${visibleDecisions.length} 条${schemeStaleTag}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px;line-height:1.7">${summaryParts.join(' · ') || '当前持仓与方案一致'}</div>
      </div>
      <span class="toggle-arrow" style="font-size:12px;color:var(--primary)"></span>
    </summary>
    <div style="padding:10px 14px;background:#f0f5ff;border-bottom:1px solid var(--border);font-size:12px;color:#1d39c4;line-height:1.7">
      📊 <b>判断维度</b>：对比"我的持有方案"目标仓位 vs 当前持仓金额，给出加仓/减仓/首次买入建议（基于资金分配偏离）。与下方"调仓建议"（基于评分替换）互补。
    </div>
    ${rows || '<div style="padding:14px 0;text-align:center;color:var(--muted);font-size:13px">✅ 当前持仓与方案目标一致</div>'}
    <div style="padding:10px 14px;font-size:11px;color:var(--muted);background:#fafafa;line-height:1.7">
      💡 <b>冷静期机制</b>：加仓需连续 3 个交易日触发、减仓/换仓需 2 个交易日，风险信号立即触发。同日多次打开不推进计数，基准为最新净值日（${latestTradeDate}）。
    </div>
  </details>`;
}

