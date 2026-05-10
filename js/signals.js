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
      const owThreshold = {money:60, bond:35, active:25, index:25, qdii:28}[fd?.cat] || 25;
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
    } else if(fd && fd.r1 < 0 && fd.r3 < 0){
      signals.push({type:'warning', priority:2, code:h.code, name:h.name,
        title:`🟡 ${h.name} 近1年/3年均负收益`,
        desc:`近1年 ${fd.r1}%，近3年 ${fd.r3}%，需关注下行趋势。`,
        action:'👀 关注观察'
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

  // 去重：同一code+type组合24小时内不重复推送；但风险信号(priority<=1)不被同code其他信号屏蔽
  const todayKey = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  let signalCooldown = JSON.parse(localStorage.getItem('_signalCooldown')||'{}');
  if(signalCooldown._date !== todayKey) signalCooldown = {_date: todayKey};
  const seenCode = new Set();
  const uniqueSignals = signals.filter(s => {
    // 风险信号(priority<=1)不受同code去重限制，确保不被低优先级信号屏蔽
    if(s.priority > 1 && seenCode.has(s.code)) return false;
    if(s.priority <= 1) seenCode.add(s.code); // 只有风险信号才占位
    else if(!seenCode.has(s.code)) seenCode.add(s.code);
    const coolKey = s.code + '|' + s.type;
    if(signalCooldown[coolKey]) return false;
    signalCooldown[coolKey] = true;
    return true;
  });
  localStorage.setItem('_signalCooldown', JSON.stringify(signalCooldown));

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
    if(holdings.some(x=>x.code===h.code)) return;
    // 纯定投持仓归入 dcaHoldings，不计入持仓基金诊断
    if(h.source === 'dca' && !h.hasDca) return;
    const nav = navCache[h.code];
    const curNav = nav ? parseFloat(nav.gsz)||1 : 1;
    const cost = h.amount || 0;
    const value = h.amount ? (h.amount / (h.cost||curNav) * curNav) : (h.value||0);
    holdings.push({code:h.code, name:h.name, value, cost, source:'existing', date:h.date});
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
      cost: (d.curval > 0) ? cost : 0, // 市值未录入时成本也置0，避免误算亏损
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

    // 结构性亏损：严重双负→红警，轻度双负→黄警
    if(fd.r1 < -5 && fd.r3 < -10){
      issues.push(`近1年(${fd.r1}%)和近3年(${fd.r3}%)持续下行，呈结构性亏损趋势`);
      level = 'red';
    } else if(fd.r1 < 0 && fd.r3 < 0){
      issues.push(`近1年(${fd.r1}%)和近3年(${fd.r3}%)均为负收益，需关注下行趋势`);
      if(level !== 'red') level = 'yellow';
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
    const _useDca = (fd.cat === 'bond' || fd.cat === 'qdii');
    const _scoreFn = f => _useDca ? calcDCAScore(f) : scoreF(f);
    const _scoreLabel = _useDca ? '定投适配评分' : '综合评分';
    const currentScore = _scoreFn(fd);
    const sameCatFunds = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);

    if(currentScore < 45){
      if(sameCatFunds.length > 0){
        const betterFunds = sameCatFunds.filter(f=>_scoreFn(f) > currentScore + 10);
        if(betterFunds.length > 0){
          const best = betterFunds.sort((a,b)=>_scoreFn(b)-_scoreFn(a))[0];
          issues.push(`${_scoreLabel} ${currentScore}分（不及格），同类有更优选择（${best.name} ${_scoreFn(best)}分），建议换仓`);
          level = 'yellow';
        } else {
          issues.push(`${_scoreLabel} ${currentScore}分（不及格），建议关注或考虑换入同类更优基金`);
          if(level==='green') level='yellow';
        }
      } else {
        issues.push(`${_scoreLabel} ${currentScore}分（不及格），建议关注基金表现`);
        if(level==='green') level='yellow';
      }
    } else if(sameCatFunds.length > 0){
      const betterFunds = sameCatFunds.filter(f=>_scoreFn(f) > currentScore + 15);
      if(betterFunds.length > 0){
        const best = betterFunds.sort((a,b)=>_scoreFn(b)-_scoreFn(a))[0];
        issues.push(`${_scoreLabel} ${currentScore}分，同类有更优选择（${best.name} ${_scoreFn(best)}分），可考虑换仓`);
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
    const _useDca2 = (fd.cat === 'bond' || fd.cat === 'qdii');
    const _scoreFn2 = f => _useDca2 ? calcDCAScore(f) : scoreF(f);
    const _scoreLabel2 = _useDca2 ? '定投适配评分' : '综合评分';
    const currentScore = _scoreFn2(fd);
    const dcaScore = calcDCAScore(fd);
    const sameCatFunds = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);

    if(currentScore < 45){
      const betterFunds = sameCatFunds.filter(f=>_scoreFn2(f) > currentScore + 10);
      if(betterFunds.length > 0){
        const best = betterFunds.sort((a,b)=>_scoreFn2(b)-_scoreFn2(a))[0];
        issues.push(`${_scoreLabel2} ${currentScore}分（较低），同类有更优选择（${best.name} ${_scoreFn2(best)}分）${statusHint}${_useDca2 ? '' : `。定投评分 ${dcaScore}分（定投适配度独立评估，与综合评分维度不同）`}`);
        level = 'yellow';
      }
    } else if(dcaScore < 60 && sameCatFunds.length > 0){
      // 定投评分不及格，提示但不强制要求换基
      const betterDcaFunds = sameCatFunds.filter(f=>calcDCAScore(f) > dcaScore + 15);
      if(betterDcaFunds.length > 0){
        const best = betterDcaFunds.sort((a,b)=>calcDCAScore(b)-calcDCAScore(a))[0];
        issues.push(`${_useDca2 ? '定投适配评分' : '定投评分'} ${dcaScore}分（不及格），同类有更适合定投的基金（${best.name} ${calcDCAScore(best)}分）${statusHint}${_useDca2 ? '' : `。综合评分 ${currentScore}分`}`);
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

  // 配比概览（内联，作为健康诊断卡片的 header 补充）
  const allocHtml = (()=>{
    const actual = { active:0, index:0, bond:0, money:0, qdii:0 };
    let actualTotal = 0;
    existingHoldings.forEach(h => {
      const fd = CURATED_FUNDS.find(f=>f.code===h.code);
      const val = h.value || h.amount || 0;
      if(fd && actual[fd.cat]!==undefined){ actual[fd.cat]+=val; actualTotal+=val; }
    });
    dcaPlans.forEach(d => {
      if(existingHoldings.some(h=>h.code===d.code)) return;
      const fd = CURATED_FUNDS.find(f=>f.code===d.code);
      const val = d.curval||0;
      if(fd && actual[fd.cat]!==undefined && val>0){ actual[fd.cat]+=val; actualTotal+=val; }
    });
    if(actualTotal===0) return '';
    let scheme=null; try{ scheme=loadMyHoldingScheme(); }catch(_){}
    const target={active:0,index:0,bond:0,money:0,qdii:0}; let targetTotal=0;
    if(scheme&&scheme.picks) scheme.picks.forEach(p=>{ if(target[p.cat]!==undefined){target[p.cat]+=(p.pct||0);targetTotal+=(p.pct||0);} });
    const catNames={active:'主动',index:'指数',bond:'债券',money:'货币',qdii:'QDII'};
    const catColors={active:'#1677ff',index:'#52c41a',bond:'#faad14',money:'#13c2c2',qdii:'#722ed1'};
    const rows=['active','index','bond','money','qdii'].map(cat=>{
      if(actual[cat]===0&&(!scheme||target[cat]===0)) return '';
      const ap=actualTotal>0?Math.round(actual[cat]/actualTotal*100):0;
      const tp=targetTotal>0?Math.round(target[cat]/targetTotal*100):null;
      const diff=tp!==null?ap-tp:null;
      const diffStr=diff===null?'':diff>0?`<span style="color:#cf1322">+${diff}%</span>`:diff<0?`<span style="color:#1677ff">${diff}%</span>`:`<span style="color:#52c41a">持平</span>`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
        <div style="width:36px;font-size:11px;color:#595959;flex-shrink:0">${catNames[cat]}</div>
        <div style="flex:1;height:6px;background:#f0f0f0;border-radius:3px;overflow:hidden"><div style="height:100%;width:${Math.min(ap,100)}%;background:${catColors[cat]};border-radius:3px"></div></div>
        <div style="width:28px;text-align:right;font-size:12px;font-weight:600;color:${catColors[cat]};flex-shrink:0">${ap}%</div>
        <div style="width:52px;text-align:right;font-size:11px;flex-shrink:0">${tp!==null?`目标${tp}% `:''}${diffStr}</div>
      </div>`;
    }).filter(Boolean).join('');
    const schemeNote=scheme?`对比目标：${scheme.savedAtDate} 方案`:'保存方案后可显示目标对比';
    return `<div style="padding:10px 16px;border-top:1px solid #f0f0f0;background:#fafafa">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:#595959">持仓配比 · 总市值 ¥${actualTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}</span>
        <span style="font-size:11px;color:var(--muted)">${schemeNote}</span>
      </div>${rows}</div>`;
  })();

  wrap.innerHTML=`<details class="card ${headerClass} alert-card" style="cursor:pointer" ${hasIssues?'open':''}>
    <summary style="list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div style="flex:1">
        <div class="alert-card-title">${headerIcon} 持仓总览 · ${holdings.length + dcaHoldings.length} 只基金</div>
        <div style="font-size:12px;color:var(--muted)">${headerMsg}</div>
      </div>
      <span class="toggle-arrow" style="font-size:12px;color:var(--primary);flex-shrink:0"></span>
    </summary>
    <div style="padding:4px 0 8px">
    ${contentHtml}
    ${strategyHtml}
    </div>
    ${allocHtml}
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
  const wrap = document.getElementById('diagnostics-rebal-wrap');
  const emptyEl = document.getElementById('diag-empty');
  if(!wrap) return;

  // 合并普通持仓 + 定投计划（去重，持仓优先）
  const evalList = [];
  existingHoldings.forEach(h=>{
    const curNav = navCache[h.code] ? parseFloat(navCache[h.code].gsz)||1 : 1;
    const cost = h.amount || 0;
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
    const _useDca3 = (fd.cat === 'bond' || fd.cat === 'qdii');
    const _scoreFn3 = f => _useDca3 ? calcDCAScore(f) : scoreF(f);
    const currentScore = _scoreFn3(fd);
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
    const sortedSameCat = sameCat.slice().sort((a,b)=>_scoreFn3(b)-_scoreFn3(a));
    const betterThan15 = sortedSameCat.filter(f=>_scoreFn3(f) > currentScore + 15);

    let best = null, reason = '';
    if(isProblem && betterThan15.length){
      best = betterThan15[0];
      reason = 'score15';
    } else if(isProblem && sortedSameCat.length){
      // 标红但同类没有高15分更优 → 仍取同类最高作为候选，避免与健康监控矛盾
      const topCandidate = sortedSameCat[0];
      if(_scoreFn3(topCandidate) > currentScore){
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
      best, bestScore: best ? _scoreFn3(best) : null,
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
      📊 <b>判断维度</b>：对比当前持仓评分 vs 同类最优基金评分，评分差 &gt;15 分且换仓成本划算时建议换仓（基于选基质量）。
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

// ═══════════════ 持仓配比概览（目标 vs 实际）═══════════════
function renderAllocOverview(){
  const wrap = document.getElementById('alloc-overview-wrap');
  if(!wrap) return;

  // 计算实际持仓各类别金额
  const actual = { active:0, index:0, bond:0, money:0, qdii:0 };
  let actualTotal = 0;
  (typeof existingHoldings !== 'undefined' ? existingHoldings : []).forEach(h => {
    const fd = (typeof CURATED_FUNDS !== 'undefined') ? CURATED_FUNDS.find(f=>f.code===h.code) : null;
    const cat = fd ? fd.cat : null;
    const val = h.value || h.amount || 0;
    if(cat && actual[cat] !== undefined){ actual[cat] += val; actualTotal += val; }
  });
  (typeof dcaPlans !== 'undefined' ? dcaPlans : []).forEach(d => {
    if((typeof existingHoldings !== 'undefined') && existingHoldings.some(h=>h.code===d.code)) return;
    const fd = (typeof CURATED_FUNDS !== 'undefined') ? CURATED_FUNDS.find(f=>f.code===d.code) : null;
    const cat = fd ? fd.cat : null;
    const val = d.curval || 0;
    if(cat && actual[cat] !== undefined && val > 0){ actual[cat] += val; actualTotal += val; }
  });

  if(actualTotal === 0){ wrap.innerHTML = ''; return; }

  // 读取目标方案
  let scheme = null;
  try { scheme = typeof loadMyHoldingScheme === 'function' ? loadMyHoldingScheme() : null; } catch(_){}

  const catNames = { active:'主动型', index:'指数', bond:'债券', money:'货币', qdii:'QDII' };
  const catColors = { active:'#1677ff', index:'#52c41a', bond:'#faad14', money:'#13c2c2', qdii:'#722ed1' };
  const cats = ['active','index','bond','money','qdii'];

  // 计算目标配比（从 scheme.picks 按类别汇总）
  const target = { active:0, index:0, bond:0, money:0, qdii:0 };
  let targetTotal = 0;
  if(scheme && scheme.picks){
    scheme.picks.forEach(p => { if(target[p.cat]!==undefined){ target[p.cat]+=(p.pct||0); targetTotal+=(p.pct||0); } });
  }

  const rows = cats.map(cat => {
    const actualAmt = actual[cat];
    if(actualAmt === 0 && (!scheme || target[cat] === 0)) return '';
    const actualPct = actualTotal > 0 ? Math.round(actualAmt / actualTotal * 100) : 0;
    const targetPct = targetTotal > 0 ? Math.round(target[cat] / targetTotal * 100) : null;
    const diff = targetPct !== null ? actualPct - targetPct : null;
    const diffStr = diff === null ? '' : diff > 0 ? `<span style="color:#cf1322">+${diff}%</span>` : diff < 0 ? `<span style="color:#1677ff">${diff}%</span>` : `<span style="color:#52c41a">持平</span>`;
    const barW = Math.min(actualPct, 100);
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f5f5f5">
      <div style="width:52px;font-size:12px;color:#595959;flex-shrink:0">${catNames[cat]}</div>
      <div style="flex:1;height:8px;background:#f0f0f0;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${barW}%;background:${catColors[cat]};border-radius:4px;transition:width .3s"></div>
      </div>
      <div style="width:36px;text-align:right;font-size:13px;font-weight:600;color:${catColors[cat]};flex-shrink:0">${actualPct}%</div>
      <div style="width:28px;text-align:right;font-size:11px;color:var(--muted);flex-shrink:0">${targetPct !== null ? `目标${targetPct}%` : ''}</div>
      <div style="width:36px;text-align:right;font-size:11px;flex-shrink:0">${diffStr}</div>
    </div>`;
  }).filter(Boolean).join('');

  const schemeNote = scheme
    ? `<span style="font-size:11px;color:var(--muted)">对比目标：${scheme.savedAtDate} 保存的方案</span>`
    : `<span style="font-size:11px;color:var(--muted)">保存智能方案后可显示目标对比</span>`;

  wrap.innerHTML = `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="card-title" style="margin:0"><span class="icon icon-blue">📊</span>当前持仓配比</div>
      ${schemeNote}
    </div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">总市值 ¥${actualTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div>
    ${rows}
  </div>`;
}

// ═══════════════ 操作建议面板（调仓 + 止盈/减仓 + 加仓时机，统一优先级排序） ═══════════════
function renderActionPanel(){
  const wrap = document.getElementById('action-panel-wrap');
  if(!wrap) return;

  // ── A. 加仓时机信号 ──
  const catRanks = typeof analyzeCategoryPerf === 'function' ? analyzeCategoryPerf() : [];
  const phaseResult = inferMomentumPhase(catRanks);
  const phase = phaseResult.phase;
  const bondYield = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS._bondYield) || null;
  const broadBaseIds = new Set(['000300','000905','000852','399006','000016','000985']);
  const valPcts = Object.entries(INDEX_VALUATION).filter(([k])=>broadBaseIds.has(k)).map(([,v])=>v.pePct).filter(v=>v>0);
  const avgValPct = valPcts.length ? valPcts.reduce((s,v)=>s+v,0)/valPcts.length : null;
  const phaseGood = ['recovery','global_bull','recession'].includes(phase);
  const phaseBad  = ['overheat','stagflation'].includes(phase);
  const valCheap  = avgValPct !== null && avgValPct < 40;
  const valPricey = avgValPct !== null && avgValPct > 70;

  let addSignal, addColor, addDesc;
  if(phaseGood && !valPricey){
    addSignal='🟢 当前适合加仓'; addColor='#389e0d';
    addDesc=`市场处于「${phaseResult.label}」阶段${valCheap?`，宽基估值偏低（PE均值 ${avgValPct.toFixed(0)}%）`:''}，加仓性价比较高。`;
  } else if(phaseBad || valPricey){
    addSignal='🔴 当前不建议加仓'; addColor='#cf1322';
    addDesc=`市场处于「${phaseResult.label}」阶段${valPricey?`，宽基估值偏高（PE均值 ${avgValPct.toFixed(0)}%）`:''}，追加资金风险较高。`;
  } else {
    addSignal='🟡 当前时机中性'; addColor='#d48806';
    addDesc=`市场处于「${phaseResult.label}」阶段${avgValPct!==null?`，宽基估值中性（PE均值 ${avgValPct.toFixed(0)}%）`:''}，可小额分批加仓。`;
  }
  if(bondYield!==null){
    if(bondYield<2.3) addDesc+=` 国债收益率 ${bondYield.toFixed(2)}%（偏低），债券加仓性价比一般。`;
    else if(bondYield>3.2) addDesc+=` 国债收益率 ${bondYield.toFixed(2)}%（偏高），债券具备配置价值。`;
  }

  // 权益超配警告
  const allHeld = typeof existingHoldings !== 'undefined' ? existingHoldings : [];
  const totalV = allHeld.reduce((s,h)=>s+(h.value||0),0);
  const equityV = allHeld.reduce((s,h)=>{ const fd=CURATED_FUNDS.find(f=>f.code===h.code); return s+(['active','index','qdii'].includes(fd&&fd.cat)?(h.value||0):0); },0);
  const equityPct = totalV>0 ? equityV/totalV*100 : 0;
  const concWarn = equityPct>70 ? `<div style="margin-top:4px;font-size:12px;color:#d48806">⚠️ 当前权益占比 ${equityPct.toFixed(0)}%，加仓前建议先检查持仓结构。</div>` : '';

  // ── 加仓方向：对比理论权重 vs 实际持仓，找出低配类别 ──
  let directionHint = '';
  let batchHint = '';
  try {
    // 读取上次方案的风险偏好和期限，没有则用默认值
    let riskP = 'balanced', horizon = 3;
    const scheme = loadMyHoldingScheme();
    if(scheme){ riskP = scheme.risk || riskP; horizon = scheme.horizon || horizon; }

    // 用当前行情重算理论权重（不依赖保存的方案）
    const theorWeights = computeWeights(riskP, horizon, catRanks, phaseResult);

    // 计算实际各类别占比
    const actual = {active:0,index:0,bond:0,money:0,qdii:0};
    allHeld.forEach(h=>{
      const fd=CURATED_FUNDS.find(f=>f.code===h.code);
      if(fd&&actual[fd.cat]!==undefined) actual[fd.cat]+=(h.value||0);
    });
    const actualPct = {};
    Object.keys(actual).forEach(k=>{ actualPct[k]=totalV>0?actual[k]/totalV*100:0; });

    // 找出低配最多的类别（理论权重 - 实际占比，差值最大的）
    const gaps = Object.keys(theorWeights)
      .map(cat=>({ cat, gap: (theorWeights[cat]||0) - (actualPct[cat]||0) }))
      .filter(x=>x.gap>5) // 低配超过5%才有意义
      .sort((a,b)=>b.gap-a.gap);

    if(gaps.length>0){
      const top = gaps[0];
      const catName = {active:'主动权益',index:'指数基金',bond:'债券',money:'货币',qdii:'QDII'}[top.cat]||top.cat;
      directionHint = `<div style="margin-top:6px;font-size:12px;color:#595959">📌 <b>建议加仓方向</b>：当前${catName}低配（实际 ${actualPct[top.cat].toFixed(0)}% vs 理论 ${theorWeights[top.cat].toFixed(0)}%），优先补充该类别。</div>`;
    }

    // 分批建议：基于 PE 百分位（Vanguard 2012 研究：低估值一次性优于分批，高估值分批优于一次性）
    if(avgValPct!==null){
      if(avgValPct<40)      batchHint='可一次性买入（低估值区间，历史上一次性投入优于分批）。';
      else if(avgValPct<60) batchHint='建议分 2 次买入，间隔 2-3 周（估值中性，分批降低时机风险）。';
      else if(avgValPct<70) batchHint='建议分 3 次买入，间隔 3-4 周（估值偏高，分批摊薄成本）。';
      else                  batchHint='建议分 4-6 次小额分批（估值偏高，降低一次性买入风险）。';
    }
    if(batchHint) directionHint += `<div style="margin-top:4px;font-size:12px;color:#595959">📌 <b>建议方式</b>：${batchHint}</div>`;
  } catch(_){}

  const addHtml = `<div style="padding:12px 16px;border-bottom:1px solid #f0f0f0">
    <div style="margin-bottom:8px">
      <span style="font-size:14px;font-weight:700;color:${addColor}">${addSignal}</span>
      <div style="font-size:12px;color:#595959;margin-top:4px;line-height:1.6">${escHtml(addDesc)}</div>
    </div>
    ${concWarn}
    ${directionHint ? `<div style="margin-top:8px;padding:8px 10px;background:#f8f9fc;border-radius:6px">${directionHint}</div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <span style="font-size:12px;color:#595959">若决定加仓，可生成方案：</span>
      <button onclick="switchTab(0)" style="padding:4px 12px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer">跳转至智能方案 →</button>
    </div>
  </div>`;

  // ── B. 止盈/减仓候选（来自持仓） ──
  const sellItems = [];
  allHeld.forEach(h=>{
    const fd=CURATED_FUNDS.find(f=>f.code===h.code);
    // h.amount = 总成本金额，h.cost = 买入净值（单价），盈亏必须用总成本
    const pnlPct=h.amount>0?(h.value-h.amount)/h.amount*100:null;
    const holdDays=h.date?Math.floor((Date.now()-new Date(h.date).getTime())/86400000):0;
    const reasons=[]; let priority=0;
    if(fd){
      const score=scoreF(fd);
      const sameCat=CURATED_FUNDS.filter(f=>f.cat===fd.cat&&f.code!==fd.code).map(f=>({f,s:scoreF(f)})).sort((a,b)=>b.s-a.s);
      const bestAlt=sameCat[0];
      // 市场过热/估值偏高时门槛降至15%，正常市场25%
      const takeProfitThreshold = (phaseBad || valPricey) ? 15 : 25;
      if(pnlPct!==null&&pnlPct>=takeProfitThreshold&&(phaseBad||valPricey)){
        // 减仓金额：给范围（浮动盈利的 30%-60%），不给精确数字避免虚假精确
        const profit = h.value - (h.amount||h.value);
        const loAmt = Math.round(profit * 0.3 / 100) * 100;
        const hiAmt = Math.round(profit * 0.6 / 100) * 100;
        const amtHint = loAmt > 0 ? `参考范围 ¥${loAmt.toLocaleString()}–¥${hiAmt.toLocaleString()}` : '';
        // 再平衡周期提示：读取上次方案保存时间
        let rebalHint = '';
        try {
          const scheme = loadMyHoldingScheme();
          if(scheme && scheme.savedAt){
            const daysSince = Math.floor((Date.now() - new Date(scheme.savedAt).getTime()) / 86400000);
            const daysToNext = Math.max(0, 180 - daysSince);
            rebalHint = daysToNext <= 30
              ? `距半年调仓周期仅剩 ${daysToNext} 天，建议提前检视整体配置`
              : `距半年调仓周期还有约 ${daysToNext} 天`;
          }
        } catch(_){}
        const fundDest = phaseGood
          ? '释放资金可重新生成智能方案，补充低配类别'
          : '释放资金建议暂存货币基金或短债，等待市场回调后重新配置';
        reasons.push({
          main: `市场「${phaseResult.label}」估值偏高，建议部分止盈`,
          amt: amtHint,
          dest: fundDest,
          rebal: rebalHint
        });
        priority=Math.max(priority,3);
      }
      if(pnlPct!==null&&pnlPct>=40){ const ann=holdDays>30?(Math.pow(1+pnlPct/100,365/holdDays)-1)*100:pnlPct; if(ann>20){
        const profit = h.value - (h.amount||h.value);
        const loAmt = Math.round(profit * 0.4 / 100) * 100;
        const hiAmt = Math.round(profit * 0.7 / 100) * 100;
        reasons.push({main:`年化收益 ${ann.toFixed(0)}%，已显著偏高，建议部分止盈`,amt:loAmt>0?`参考范围 ¥${loAmt.toLocaleString()}–¥${hiAmt.toLocaleString()}`:'',dest:'释放资金重新生成智能方案配置',rebal:''});
        priority=Math.max(priority,2);
      } }
      if(score<50&&bestAlt&&bestAlt.s>score+15){ reasons.push({main:`评分 ${score} 分，同类「${bestAlt.f.name}」${bestAlt.s} 分，建议换仓`,amt:'',dest:'',rebal:''}); priority=Math.max(priority,2); }
      if(fd.r1<-5&&fd.r3<-10){ reasons.push({main:`近1年 ${fd.r1}%、近3年 ${fd.r3}%，持续下行`,amt:'',dest:'建议减仓止损',rebal:''}); priority=Math.max(priority,3); }
    } else if(pnlPct!==null&&pnlPct<-15){
      reasons.push({main:`亏损 ${Math.abs(pnlPct).toFixed(1)}%，已移出精选库`,amt:'',dest:'建议评估止损',rebal:''}); priority=2;
    }
    if(reasons.length){
      const fee=holdDays<7?'1.50%':holdDays<30?'0.75%':holdDays<365?'0.50%':'0%';
      sellItems.push({name:h.name,code:h.code,value:h.value,pnlPct,reasons,priority,feeNote:holdDays>0?`持有 ${holdDays} 天，赎回费约 ${fee}`:''});
    }
  });
  sellItems.sort((a,b)=>b.priority-a.priority);

  // ── C. 调仓建议（来自 renderDiagnostics 的逻辑，复用 evalList） ──
  const evalList=[];
  existingHoldings.forEach(h=>{
    const curNav=navCache[h.code]?parseFloat(navCache[h.code].gsz)||1:1;
    const cost=h.amount||0; const value=h.amount?(h.amount/(h.cost||curNav)*curNav):(h.value||0);
    evalList.push({code:h.code,name:h.name,value,cost,source:'existing',date:h.date});
  });
  (typeof dcaPlans!=='undefined'?dcaPlans:[]).forEach(d=>{
    if(evalList.some(x=>x.code===d.code)) return;
    if(!d.curval||d.curval<=0) return;
    const executedCount=d.execLog?Object.keys(d.execLog).filter(k=>d.execLog[k]).length:0;
    const cost=executedCount>0?executedCount*d.monthly:Math.max(0,Math.floor((new Date()-new Date(d.start||Date.now()))/30/86400000))*d.monthly;
    evalList.push({code:d.code,name:d.name,value:d.curval,cost,source:'dca',date:d.start});
  });

  const catStats={};
  ['active','index','bond','money','qdii'].forEach(cat=>{
    if(_catBench&&_catBench[cat]) catStats[cat]={avgR1:_catBench[cat].avgR1,stdR1:_catBench[cat].stdR1};
    else { const fs=CURATED_FUNDS.filter(f=>f.cat===cat); if(!fs.length) return; const avg=fs.reduce((s,f)=>s+f.r1,0)/fs.length; catStats[cat]={avgR1:avg,stdR1:Math.sqrt(fs.reduce((s,f)=>s+(f.r1-avg)**2,0)/fs.length)||1}; }
  });

  const rebalItems=[];
  evalList.forEach(h=>{
    const fd=CURATED_FUNDS.find(f=>f.code===h.code); if(!fd) return;
    const _useDca=(fd.cat==='bond'||fd.cat==='qdii');
    const _score=f=>_useDca?calcDCAScore(f):scoreF(f);
    const currentScore=_score(fd);
    const stats=catStats[fd.cat]; const zScore=stats?(fd.r1-stats.avgR1)/stats.stdR1:0;
    const isProblem=(fd.r1<-10&&fd.r3<-15)||(stats&&zScore<-2.5)||(fd.r1<0&&fd.maxDD>0&&(-fd.r1/fd.maxDD*100)>80)||currentScore<45;
    if(!isProblem) return;
    const sorted=CURATED_FUNDS.filter(f=>f.cat===fd.cat&&f.code!==fd.code).map(f=>({f,s:_score(f)})).sort((a,b)=>b.s-a.s);
    const best=sorted[0];
    if(!best) return;
    const holdDays=h.date?Math.floor((Date.now()-new Date(h.date).getTime())/86400000):365;
    const costInfo=typeof calculateRebalanceCost==='function'?calculateRebalanceCost(fd,best.f,holdDays,h.value):null;
    rebalItems.push({h,fd,currentScore,best:best.f,bestScore:best.s,pnlPct:h.cost>0?(h.value-h.cost)/h.cost*100:null,source:h.source,costInfo});
  });

  // ── 合并渲染 ──
  const hasSell=sellItems.length>0;
  const hasRebal=rebalItems.length>0;

  const sellHtml = !hasSell
    ? `<div style="font-size:13px;color:var(--muted);padding:8px 0">当前持仓无明显止盈或减仓信号。</div>`
    : `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`
      + sellItems.map(c=>{
        const reasonHtml = c.reasons.map(r=>{
          const isObj = typeof r === 'object';
          if(!isObj) return `<div style="font-size:12px;color:#595959">${escHtml(r)}</div>`;
          return `<div style="font-size:13px;font-weight:600;color:#262626;margin-bottom:3px">${escHtml(r.main)}</div>`
            + (r.amt ? `<div style="font-size:12px;color:#d48806">建议减仓金额：${escHtml(r.amt)}（具体根据资金需求决定）</div>` : '')
            + (r.dest ? `<div style="font-size:12px;color:#595959">资金去向：${escHtml(r.dest)}</div>` : '')
            + (r.rebal ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${escHtml(r.rebal)}</div>` : '');
        }).join('');
        return `<div style="padding:10px 12px;background:#fafafa;border-radius:8px;border:1px solid #f0f0f0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:700;color:#262626">${escHtml(c.name)}</span>
            ${c.pnlPct!==null?`<span style="font-size:13px;font-weight:700;color:${c.pnlPct>=0?'#389e0d':'#cf1322'};padding:1px 7px;background:${c.pnlPct>=0?'#f6ffed':'#fff1f0'};border-radius:4px">${c.pnlPct>=0?'+':''}${c.pnlPct.toFixed(1)}%</span>`:''}
            <span style="font-size:12px;color:var(--muted)">¥${(c.value||0).toLocaleString('zh-CN',{maximumFractionDigits:0})}</span>
          </div>
          <div style="padding:8px 10px;background:#fff;border-radius:6px;border-left:3px solid #faad14">${reasonHtml}</div>
          ${c.feeNote?`<div style="font-size:11px;color:var(--muted);margin-top:5px">${escHtml(c.feeNote)}</div>`:''}
        </div>`;
      }).join('')
      + `</div>`;

  const rebalHtml = !hasRebal ? '' : rebalItems.map(s=>{
    const costNotWorth=s.costInfo&&!s.costInfo.worthIt;
    const actionLabel=costNotWorth?'👀 暂不建议换':s.source==='dca'?'🔄 换入定投':'🔄 建议换仓';
    const costNote=s.costInfo?(costNotWorth
      ?`<div style="font-size:11px;color:#d46b08;margin-top:5px;padding:4px 8px;background:#fff7e6;border-radius:4px">换仓成本 ${(s.costInfo.totalCostRate*100).toFixed(2)}%，回本周期${s.costInfo.breakEvenYears<99?s.costInfo.breakEvenYears.toFixed(1)+'年':'极长'}，当前不划算</div>`
      :`<div style="font-size:11px;color:#389e0d;margin-top:5px;padding:4px 8px;background:#f6ffed;border-radius:4px">换仓成本 ${(s.costInfo.totalCostRate*100).toFixed(2)}%，预计 ${s.costInfo.breakEvenYears.toFixed(1)} 年回本，划算</div>`):'';
    const actionStyle=costNotWorth?'color:var(--muted);background:#f5f5f5;border:1px solid #d9d9d9':'color:#d48806;background:#fff7e6;border:1px solid #ffd591';
    return `<div style="padding:10px 12px;margin-bottom:8px;background:#fafafa;border-radius:8px;border:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600;color:#cf1322;padding:3px 8px;background:#fff1f0;border:1px solid #ffccc7;border-radius:5px">${escHtml(s.fd.name)} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.currentScore}分</span></span>
        <span style="color:var(--muted);font-size:16px">→</span>
        <span style="font-size:13px;font-weight:600;color:#389e0d;padding:3px 8px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:5px">${escHtml(s.best.name)} <span style="font-size:11px;font-weight:400;color:var(--muted)">${s.bestScore}分</span></span>
        <span style="margin-left:auto;font-size:12px;font-weight:600;${actionStyle};padding:3px 10px;border-radius:5px;white-space:nowrap">${actionLabel}</span>
      </div>
      ${costNote}
    </div>`;
  }).join('');

  const sectionTitle = (text, icon) =>
    `<div style="display:flex;align-items:center;gap:6px;margin:14px 0 8px;padding-bottom:6px;border-bottom:2px solid #f0f0f0">
      <span style="font-size:15px">${icon}</span>
      <span style="font-size:14px;font-weight:700;color:#262626">${text}</span>
    </div>`;

  wrap.innerHTML=`<div class="card" style="margin-bottom:12px">
    <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
      <span><span class="icon icon-blue">💡</span>行动建议</span>
      <button class="help-btn" onclick="showHelpModal('💡 行动建议 · 理论依据', \`
        <div style='margin-bottom:16px'>
          <div style='font-size:14px;font-weight:700;color:var(--primary);margin-bottom:6px'>💰 加仓时机</div>
          <div style='font-size:13px;color:#595959;line-height:1.8'>
            · <b>市场阶段（phase）</b>：基于5类资产近期相对强弱推断动量状态，5年回测命中率60.6%<br>
            · <b>PE百分位</b>：宽基指数估值百分位，Shiller CAPE研究证明估值对长期收益有预测力<br>
            · <b>加仓方向</b>：用Risk Parity算法实时重算理论权重，对比实际持仓找出低配类别<br>
            · <b>分批方式</b>：基于Vanguard 2012研究——低估值一次性优于分批，高估值分批优于一次性
          </div>
        </div>
        <div style='margin-bottom:16px'>
          <div style='font-size:14px;font-weight:700;color:#d48806;margin-bottom:6px'>📤 止盈 / 减仓</div>
          <div style='font-size:13px;color:#595959;line-height:1.8'>
            · <b>动态门槛</b>：市场高估值（PE&gt;70%）时门槛降至15%，正常市场25%——估值越高均值回归压力越大<br>
            · <b>减仓金额范围</b>：只减浮动盈利的30%-60%，本金不动；不给精确数字避免虚假精确感<br>
            · <b>再平衡周期</b>：提示距半年调仓周期还有多少天，依据：5年回测验证半年调仓最优（U型曲线）<br>
            · <b>局限</b>：A股短期有动量效应，止盈信号在动量窗口内可能偏早触发
          </div>
        </div>
        <div>
          <div style='font-size:14px;font-weight:700;color:#cf1322;margin-bottom:6px'>🔄 换仓建议</div>
          <div style='font-size:13px;color:#595959;line-height:1.8'>
            · <b>触发条件</b>：结构性亏损 / 严重落后同类（Z&lt;-2.5σ）/ 回撤溢出 / 评分&lt;45，任一满足<br>
            · <b>成本评估</b>：赎回费+申购费+回本期，回本期&lt;1.5年才建议换仓<br>
            · <b>评分体系</b>：主动/指数用scoreF（Top-Bot差20-30pp有预测力），债券/QDII用混合评分（因scoreF对这两类R²≈0.002）
          </div>
        </div>
      \`)" title="查看理论依据">?</button>
    </div>
    ${sectionTitle('加仓时机','💰')}
    ${addHtml}
    ${sectionTitle('止盈 / 减仓','📤')}
    ${sellHtml}
    ${hasRebal?sectionTitle('换仓建议','🔄')+rebalHtml:''}
  </div>`;
}

// ═══════════════ 加仓时机 + 止盈提示 ═══════════════
function renderTimingAdvice(){
  const wrap = document.getElementById('timing-advice-wrap');
  if(!wrap) return;

  // ── 1. 加仓时机：基于 phase + 估值 ──
  const catRanks = typeof analyzeCategoryPerf === 'function' ? analyzeCategoryPerf() : [];
  const phaseResult = inferMomentumPhase(catRanks);
  const phase = phaseResult.phase;
  const bondYield = (typeof MARKET_BENCHMARKS === 'object' && MARKET_BENCHMARKS._bondYield) || null;

  // 宽基指数估值均值（只取宽基，排除行业指数避免均值失真）
  const broadBaseIds = new Set(['000300','000905','000852','399006','000016','000985']);
  const valPcts = Object.entries(INDEX_VALUATION)
    .filter(([k]) => broadBaseIds.has(k))
    .map(([,v]) => v.pePct).filter(v => v > 0);
  const avgValPct = valPcts.length ? valPcts.reduce((s,v)=>s+v,0)/valPcts.length : null;

  // 加仓信号：phase + 估值双维度
  let addSignal, addColor, addBg, addDesc;
  const phaseGood = ['recovery','global_bull','recession'].includes(phase);
  const phaseBad  = ['overheat','stagflation'].includes(phase);
  const valCheap  = avgValPct !== null && avgValPct < 40;
  const valPricey = avgValPct !== null && avgValPct > 70;

  if(phaseGood && !valPricey){
    addSignal = '🟢 当前适合加仓';
    addColor  = '#389e0d'; addBg = '#f6ffed';
    addDesc   = `市场处于「${phaseResult.label}」阶段${valCheap ? `，宽基指数估值偏低（PE百分位均值 ${avgValPct.toFixed(0)}%）` : ''}，加仓性价比较高。`;
  } else if(phaseBad || valPricey){
    addSignal = '🔴 当前不建议加仓';
    addColor  = '#cf1322'; addBg = '#fff1f0';
    addDesc   = `市场处于「${phaseResult.label}」阶段${valPricey ? `，宽基指数估值偏高（PE百分位均值 ${avgValPct.toFixed(0)}%）` : ''}，追加资金风险较高，建议等待更好时机。`;
  } else {
    addSignal = '🟡 当前时机中性';
    addColor  = '#d48806'; addBg = '#fffbe6';
    addDesc   = `市场处于「${phaseResult.label}」阶段${avgValPct !== null ? `，宽基指数估值中性（PE百分位均值 ${avgValPct.toFixed(0)}%）` : ''}，可小额分批加仓，不建议一次性大额投入。`;
  }

  // bond 利率环境补充
  let bondNote = '';
  if(bondYield !== null){
    if(bondYield < 2.3) bondNote = `国债收益率 ${bondYield.toFixed(2)}%（偏低），债券类加仓性价比一般。`;
    else if(bondYield > 3.2) bondNote = `国债收益率 ${bondYield.toFixed(2)}%（偏高），债券类当前具备配置价值。`;
  }

  // 持仓集中度警告（权益超配时加仓需谨慎）
  let concWarn = '';
  const allHeld = (typeof existingHoldings !== 'undefined' ? existingHoldings : []);
  if(allHeld.length > 0){
    const totalV = allHeld.reduce((s,h)=>s+(h.value||0),0);
    const equityV = allHeld.reduce((s,h)=>{
      const fd = CURATED_FUNDS.find(f=>f.code===h.code);
      return s + (['active','index','qdii'].includes(fd&&fd.cat) ? (h.value||0) : 0);
    },0);
    const equityPct = totalV > 0 ? equityV/totalV*100 : 0;
    if(equityPct > 70) concWarn = `<div style="margin-top:6px;font-size:12px;color:#d48806">⚠️ 你当前权益类占比 ${equityPct.toFixed(0)}%，加仓前建议先检查持仓结构，避免进一步超配。</div>`;
  }

  // ── 2. 止盈/卖出提示：遍历持仓，找出止盈/减仓候选 ──
  const sellCandidates = [];
  allHeld.forEach(h => {
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const pnlPct = h.cost > 0 ? (h.value - h.cost) / h.cost * 100 : null;
    const holdDays = h.date ? Math.floor((Date.now() - new Date(h.date).getTime()) / 86400000) : 0;
    const reasons = [];
    let priority = 0; // 越高越优先展示

    if(fd){
      const score = scoreF(fd);
      const sameCat = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code)
        .map(f=>({f, s:scoreF(f)})).sort((a,b)=>b.s-a.s);
      const bestAlt = sameCat[0];

      // 止盈：盈利 ≥ 25% + 市场过热或估值偏高
      if(pnlPct !== null && pnlPct >= 25 && (phaseBad || valPricey)){
        reasons.push(`盈利 ${pnlPct.toFixed(1)}%，当前市场「${phaseResult.label}」，建议锁定部分利润`);
        priority = Math.max(priority, 3);
      }
      // 止盈：盈利 ≥ 40% 且年化收益 > 20%（排除长期持有低年化的情况）
      if(pnlPct !== null && pnlPct >= 40){
        const annPnl = holdDays > 30 ? (Math.pow(1 + pnlPct/100, 365/holdDays) - 1) * 100 : pnlPct;
        if(annPnl > 20){
          reasons.push(`盈利已达 ${pnlPct.toFixed(1)}%（年化 ${annPnl.toFixed(0)}%），可考虑止盈 30-50%`);
          priority = Math.max(priority, 2);
        }
      }
      // 减仓：评分低 + 同类有更优
      if(score < 50 && bestAlt && bestAlt.s > score + 15){
        reasons.push(`综合评分 ${score} 分，同类「${bestAlt.f.name}」评分 ${bestAlt.s} 分，建议换仓`);
        priority = Math.max(priority, 2);
      }
      // 减仓：结构性亏损（双负）
      if(fd.r1 < -5 && fd.r3 < -10){
        reasons.push(`近1年 ${fd.r1}%、近3年 ${fd.r3}%，持续下行，建议减仓止损`);
        priority = Math.max(priority, 3);
      }
    } else {
      // 不在精选库 + 亏损
      if(pnlPct !== null && pnlPct < -15){
        reasons.push(`亏损 ${Math.abs(pnlPct).toFixed(1)}%，且已移出精选库，建议评估是否止损`);
        priority = 2;
      }
    }

    if(reasons.length > 0){
      // 赎回费提示
      const fee = holdDays < 7 ? '1.50%' : holdDays < 30 ? '0.75%' : holdDays < 365 ? '0.50%' : '0%';
      const feeNote = holdDays > 0 ? `持有 ${holdDays} 天，赎回费约 ${fee}` : '';
      sellCandidates.push({ name: h.name, code: h.code, value: h.value, pnlPct, reasons, priority, feeNote });
    }
  });

  sellCandidates.sort((a,b) => b.priority - a.priority);

  const sellHtml = sellCandidates.length === 0
    ? `<div style="font-size:13px;color:var(--muted);padding:4px 0">当前持仓无明显止盈或减仓信号。</div>`
    : sellCandidates.map(c => `
      <div style="padding:8px 0;border-bottom:1px solid #f5f5f5">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600">${escHtml(c.name)}</span>
          <code style="font-size:10px;color:var(--muted)">${escHtml(c.code)}</code>
          ${c.pnlPct !== null ? `<span style="font-size:12px;color:${c.pnlPct>=0?'#389e0d':'#cf1322'};font-weight:600">${c.pnlPct>=0?'+':''}${c.pnlPct.toFixed(1)}%</span>` : ''}
          <span style="font-size:12px;color:var(--muted)">¥${(c.value||0).toLocaleString('zh-CN',{maximumFractionDigits:0})}</span>
        </div>
        ${c.reasons.map(r=>`<div style="font-size:12px;color:#595959;padding-left:4px">· ${escHtml(r)}</div>`).join('')}
        ${c.feeNote ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;padding-left:4px">${escHtml(c.feeNote)}</div>` : ''}
      </div>`).join('');

  wrap.innerHTML = `
  <div class="card" style="margin-bottom:12px">
    <div class="card-title"><span class="icon icon-green">💡</span>加仓时机参考</div>
    <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0">
      <span style="font-size:14px;font-weight:700;color:${addColor};white-space:nowrap">${addSignal}</span>
      <div style="font-size:13px;color:#595959;line-height:1.6">${escHtml(addDesc)}${bondNote ? '<br><span style="color:var(--muted)">' + escHtml(bondNote) + '</span>' : ''}</div>
    </div>
    ${concWarn}
    <button onclick="switchTab(0)" style="margin-top:8px;padding:5px 14px;font-size:12px;background:var(--primary);color:#fff;border:none;border-radius:6px;cursor:pointer">生成加仓方案 →</button>
  </div>
  <div class="card" style="margin-bottom:12px">
    <div class="card-title"><span class="icon icon-red">📤</span>止盈 / 减仓参考</div>
    ${sellHtml}
  </div>`;
}
