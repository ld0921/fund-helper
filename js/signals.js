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

  // 合并所有持仓来源
  const allHeld = [];
  existingHoldings.forEach(h=>{
    if(!allHeld.some(x=>x.code===h.code)){
      // 直接使用已计算好的 h.value，避免用 gsz 重新估算导致偏差
      const cost = h.amount || 0;
      const value = h.value || h.amount || 0;
      allHeld.push({code:h.code, name:h.name, value, cost, status:h.status||'confirmed'});
    }
  });
  dcaPlans.forEach(d=>{ if(!allHeld.some(x=>x.code===d.code)&&d.curval>0){
    const months=d.start?Math.max(0,Math.floor((new Date()-new Date(d.start))/30/86400000)):0;
    allHeld.push({code:d.code,name:d.name,value:d.curval,cost:d.monthly*months});
  }});

  if(!allHeld.length && !CURATED_FUNDS.length) return;

  const signals = [];
  const catRanks = Object.keys(navCache).length > 0 ? analyzeCategoryPerf() : null;

  // === 持仓信号（基于已持基金） ===
  allHeld.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const nav = navCache[h.code];
    if(!nav) return;
    const chg = parseFloat(nav.gszzl)||0;
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

    // 信号2：持仓基金大涨（≥3%），考虑部分止盈
    if(chg >= 3){
      signals.push({type:'success', priority:2, code:h.code, name:h.name,
        title:`🚀 ${h.name} 今日大涨 ${chg.toFixed(2)}%`,
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
  const listEl = document.getElementById('signal-modal-list');

  if(!signals.length){
    // 无信号：铃铛保留，隐藏角标，清空列表
    if(badge) badge.style.display = 'none';
    if(titleEl) titleEl.textContent = '📡 智能监控 · 暂无信号';
    if(listEl) listEl.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--muted);font-size:13px">✅ 当前没有需要关注的信号<br>系统会持续监控您的持仓和市场动态</div>';
    return;
  }

  // 显示角标数字
  if(badge){ badge.style.display = ''; badge.textContent = signals.length > 99 ? '99+' : signals.length; }

  const dangerCount = signals.filter(s=>s.type==='danger'||s.type==='warning').length;

  if(titleEl) titleEl.textContent = `📡 智能监控 · ${signals.length} 条信号`;

  const typeColors = {
    danger: {bg:'#fff1f0', border:'#ffa39e', color:'#cf1322'},
    warning: {bg:'#fff7e6', border:'#ffd591', color:'#ad6800'},
    opportunity: {bg:'#f6ffed', border:'#b7eb8f', color:'#237804'},
    success: {bg:'#f6ffed', border:'#b7eb8f', color:'#237804'},
    info: {bg:'#e6f4ff', border:'#91caff', color:'#0958d9'},
  };

  if(listEl) listEl.innerHTML = signals.map(s => {
    const tc = typeColors[s.type] || typeColors.info;
    return `<div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:${tc.color};margin-bottom:3px">${escHtml(s.title)}</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6">${escHtml(s.desc)}</div>
      </div>
      <div style="flex-shrink:0;font-size:12px;font-weight:600;color:${tc.color};padding:3px 8px;background:${tc.bg};border-radius:6px;white-space:nowrap">${escHtml(s.action)}</div>
    </div>`;
  }).join('');

  // 有危险信号且内容变化时才自动弹出（避免切Tab重复打扰）
  if(dangerCount > 0){
    const dangerHash = signals.filter(s=>s.type==='danger'||s.type==='warning').map(s=>s.code+s.title).join('|');
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

// ═══════════════ 持仓健康诊断（动态阈值 + 集中度分析） ═══════════════
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
  // 合并 existingHoldings + dcaPlans
  const allHeld = [];
  existingHoldings.forEach(h=>{
    if(!allHeld.some(x=>x.code===h.code)){
      const nav = navCache[h.code];
      const curNav = nav ? parseFloat(nav.gsz)||1 : 1;
      const cost = h.amount || h.value || 0;
      const value = h.amount ? (h.amount / (h.cost||curNav) * curNav) : (h.value||0);
      allHeld.push({code:h.code, name:h.name, value, cost, source:'existing'});
    }
  });
  dcaPlans.forEach(d=>{ if(!allHeld.some(x=>x.code===d.code)&&d.curval>0){
    const months=d.start?Math.max(0,Math.floor((new Date()-new Date(d.start))/30/86400000)):0;
    allHeld.push({code:d.code,name:d.name,value:d.curval,cost:d.monthly*months,source:'dca'});
  }});

  if(!allHeld.length){ wrap.innerHTML=''; return; }

  // 计算各类别统计（均值 + 标准差，用于动态阈值）
  const catStats = {};
  ['active','index','bond','money','qdii'].forEach(cat=>{
    const fs=CURATED_FUNDS.filter(f=>f.cat===cat);
    if(!fs.length) return;
    const avgR1 = fs.reduce((s,f)=>s+f.r1,0)/fs.length;
    const stdR1 = Math.sqrt(fs.reduce((s,f)=>s+(f.r1-avgR1)**2,0)/fs.length)||1;
    catStats[cat] = { avgR1, stdR1, count:fs.length };
  });

  const catRanksCache = Object.keys(navCache).length>0 ? analyzeCategoryPerf() : null;
  const totalPortValue = allHeld.reduce((s,h)=>s+h.value,0);

  const alerts = [];
  const okList = [];

  // 集中度检查
  const catConcentration = {};
  allHeld.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const cat = fd ? fd.cat : 'other';
    catConcentration[cat] = (catConcentration[cat]||0) + h.value;
  });

  // 单只基金集中度 + 表现综合诊断（合并为一条，避免同一基金出现多行）
  allHeld.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    const nav = navCache[h.code];
    const todayChg = nav ? parseFloat(nav.gszzl)||0 : null;
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
      if(pnlPct!==null && pnlPct < -15){
        issues.push(`持仓亏损 ${pnlPct.toFixed(1)}%，已超过-15%预警线。该基金不在精选库`);
        level = 'red';
      }
      if(issues.length){
        alerts.push({code:h.code,name:h.name,level, desc:issues.join('；')+'。', action:level==='red'?'🔴 建议减仓':'🟡 需分散'});
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

    // 3. 当前亏损占最大回撤比例
    if(pnlPct !== null && pnlPct < 0 && fd.maxDD > 0){
      const ddRatio = (-pnlPct / fd.maxDD * 100);
      if(ddRatio > 80){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，已达历史最大跌幅(${fd.maxDD}%)的 ${ddRatio.toFixed(0)}%，接近极端水平`);
        if(level !== 'red') level = 'red';
      } else if(ddRatio > 50){
        issues.push(`当前亏损 ${pnlPct.toFixed(1)}%，占历史最大跌幅(${fd.maxDD}%)的 ${ddRatio.toFixed(0)}%`);
        if(level === 'green') level = 'yellow';
      }
    }

    // 4. 今日大跌
    if(todayChg!==null && todayChg < -2){
      issues.push(`今日下跌 ${todayChg.toFixed(2)}%，关注是否有负面消息驱动`);
      if(level==='green') level='yellow';
    }

    // 5. 类别行情末位且仓位大
    if(catRanksCache){
      const catRank = catRanksCache.findIndex(c=>c.cat===fd.cat);
      if(catRank>=3 && h.value > 5000){
        issues.push(`所属类别「${fd.label}」当前行情排名第${catRank+1}位（末段），持仓市值 ¥${h.value.toLocaleString()}`);
        if(level==='green') level='yellow';
      }
    }

    // 6. 性价比诊断：Alpha评分 × 估值信号，识别"高价低质"持仓
    const currentScore = scoreF(fd);
    const sameCatFunds = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);
    if(sameCatFunds.length > 0){
      const betterFunds = sameCatFunds.filter(f=>scoreF(f) > currentScore + 10);
      if(betterFunds.length > 0 && currentScore < 60){
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
      alerts.push({code:h.code,name:h.name,level,
        desc: issues.join('；') + '。' + advice,
        action: actionMap[level]});
    } else {
      okList.push({code:h.code,name:h.name,level:'green',
        desc:`表现正常。近1年 ${fd.r1>0?'+':''}${fd.r1}%，同类均值 ${stats.avgR1.toFixed(1)}%。${todayChg!==null?`今日 ${todayChg>0?'+':''}${todayChg.toFixed(2)}%。`:''}继续持有。`,
        action:'🟢 持有'});
    }
  });

  // 类别集中度预警（独立条目）
  Object.keys(catConcentration).forEach(cat=>{
    if(cat === 'other') return;
    const catPct = totalPortValue > 0 ? catConcentration[cat] / totalPortValue * 100 : 0;
    if(catPct > 60){
      const catName = CAT_NAMES[cat] || cat;
      alerts.push({code:'_cat_'+cat,name:`${catName}类别`,level:'yellow',
        desc:`${catName}类别占总持仓 ${catPct.toFixed(1)}%，超过60%警戒线。建议分散到其他类别。`,
        action:'🟡 需分散'});
    }
  });

  if(!alerts.length && !okList.length){ wrap.innerHTML=''; return; }

  const redCount = alerts.filter(a=>a.level==='red').length;
  const yellowCount = alerts.filter(a=>a.level==='yellow').length;
  const headerClass = redCount>0?'':'alert-green';
  const headerIcon = redCount>0?'🔴':yellowCount>0?'🟡':'✅';
  const headerMsg = redCount>0?`发现 ${redCount} 项高风险预警，${yellowCount} 项关注信号`:
    yellowCount>0?`发现 ${yellowCount} 项关注信号，其余持仓表现良好`:'所有持仓表现良好，当前策略合理';

  const renderItem = a => `<div class="health-item">
    <div class="health-dot health-${a.level}"></div>
    <div class="health-fund">
      <div class="health-name">${escHtml(a.name)} <code style="font-size:10px;color:var(--muted)">${escHtml(a.code)}</code></div>
      <div class="health-desc">${escHtml(a.desc)}</div>
    </div>
    <div class="health-action" style="color:${a.level==='red'?'var(--danger)':a.level==='yellow'?'var(--warning)':'var(--success)'}">${escHtml(a.action)}</div>
  </div>`;

  const hasIssues = alerts.length > 0;
  wrap.innerHTML=`<details class="card ${headerClass} alert-card" style="padding:0;overflow:hidden;cursor:pointer" ${hasIssues?'open':''}>
    <summary style="padding:14px 16px;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <div style="flex:1">
        <div class="alert-card-title" style="margin-bottom:2px">${headerIcon} 持仓健康诊断 · ${allHeld.length} 只基金</div>
        <div style="font-size:12px;color:var(--muted)">${headerMsg}</div>
      </div>
      <span class="toggle-arrow" style="font-size:12px;color:var(--primary);flex-shrink:0"></span>
    </summary>
    <div style="border-top:1px solid #f0f0f0">
    ${[...alerts,...okList].map(renderItem).join('')}
    <div style="padding:8px 14px;font-size:11px;color:var(--muted);background:#fafafa">
      💡 诊断基于同类基金对比 + 持仓集中度分析。${Object.keys(navCache).length>0?'已融合实时行情数据':'建议等待净值加载后刷新'}。
    </div>
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
  renderTransactionHistory();
  checkDcaReminder();
  checkHoldingConfirmReminder();
  checkRedeemArrivalReminder();
  document.getElementById('eh-date').valueAsDate=new Date();
  document.getElementById('dp-start').valueAsDate=new Date();

  // 3.1 自动获取所有持仓基金的净值数据
  if(existingHoldings.length > 0){
    existingHoldings.forEach(h => {
      fetchNav(h.code, data => {
        if(data) {
          navCache[h.code] = {...data, fundcode: h.code};
          FundDB.set('navCache', navCache);
          renderExistingHoldings();
        }
      });
    });
  }

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
          pullFromCloud().then(()=>{ if(localStorage.getItem('_syncPending')) pushToCloud(); });
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
            pullFromCloud().then(()=>{ if(localStorage.getItem('_syncPending')) pushToCloud(); });
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
        _supa.auth.getSession().then(({data:{session}}) => {
          if(_sessionResolved) return;
          _sessionResolved = true;
          if(session?.user){
            _currentUser = session.user;
            updateAuthUI();
            FundDB.onSync(_debounce(pushToCloud, 2000));
            pullFromCloud().then(()=>{ if(localStorage.getItem('_syncPending')) pushToCloud(); });
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

  // 7. 自动刷新持仓净值数据（如果数据过期或有持仓）
  const lastRefreshTime = await FundDB.get('lastNavRefreshTime') || 0;
  const dataAge = Date.now() - lastRefreshTime;
  const needRefresh = existingHoldings.length > 0 && (dataAge > 30 * 60 * 1000); // 超过30分钟

  if(needRefresh){
    console.log('[自动刷新] 持仓净值数据已过期，自动刷新中...');
    // 延迟2秒后自动刷新，避免阻塞页面加载
    setTimeout(()=>{
      refreshHoldingsNav(true); // 只刷新持仓基金，静默模式
    }, 2000);
  }

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
    refreshHoldingsNav(true); // 只刷新持仓基金
  }, 5 * 60 * 1000);
  // 页面从后台恢复时立即刷新一次
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden && existingHoldings.length > 0) refreshHoldingsNav(true);
  });
})();

// ═══════════════ 持仓诊断：主动调仓建议 ═══════════════
function renderDiagnostics(){
  const wrap = document.getElementById('diagnostics-rebal-wrap');
  const emptyEl = document.getElementById('diag-empty');
  if(!wrap) return;

  if(!existingHoldings.length){
    wrap.innerHTML = '';
    if(emptyEl) emptyEl.style.display = '';
    return;
  }
  if(emptyEl) emptyEl.style.display = 'none';

  const suggestions = [];
  existingHoldings.forEach(h=>{
    const fd = CURATED_FUNDS.find(f=>f.code===h.code);
    if(!fd) return;
    const currentScore = scoreF(fd);
    const sameCat = CURATED_FUNDS.filter(f=>f.cat===fd.cat && f.code!==fd.code);
    const better = sameCat.filter(f=>scoreF(f) > currentScore + 15).sort((a,b)=>scoreF(b)-scoreF(a));
    if(!better.length) return;
    const best = better[0];
    const bestScore = scoreF(best);
    const pnlPct = h.cost>0 ? (h.value-h.cost)/h.cost*100 : null;
    suggestions.push({ holding:h, fd, currentScore, best, bestScore, pnlPct });
  });

  if(!suggestions.length){
    wrap.innerHTML = `<div class="card"><div class="card-title"><span class="icon icon-blue">🔄</span>调仓建议</div><div style="padding:16px 0;text-align:center;color:var(--muted);font-size:13px">✅ 当前持仓均为同类最优选择，无需调仓</div></div>`;
    return;
  }

  const rows = suggestions.map(s=>{
    const pnlStr = s.pnlPct!==null ? `持仓${s.pnlPct>=0?'+':''}${s.pnlPct.toFixed(1)}%` : '';
    const redeemTip = s.pnlPct!==null && s.pnlPct < 0 ? '（当前亏损，换仓需承担浮亏）' : '';
    return `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">
          <span style="color:var(--danger)">${escHtml(s.fd.name)}</span>
          <span style="color:var(--muted);font-size:11px;margin-left:4px">${s.currentScore}分</span>
          <span style="margin:0 6px;color:var(--muted)">→</span>
          <span style="color:var(--success)">${escHtml(s.best.name)}</span>
          <span style="color:var(--muted);font-size:11px;margin-left:4px">${s.bestScore}分</span>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.6">
          评分差 +${s.bestScore-s.currentScore}分 · ${pnlStr}${redeemTip}<br>
          ${escHtml(s.best.name)}：近1年${s.best.r1>0?'+':''}${s.best.r1}%，近3年${s.best.r3>0?'+':''}${s.best.r3}%，经理任期${s.best.mgrYears}年
        </div>
      </div>
      <div style="flex-shrink:0;font-size:12px;font-weight:600;color:var(--warning);padding:3px 8px;background:#fff7e6;border-radius:6px;white-space:nowrap">🔄 建议换仓</div>
    </div>`;
  }).join('');

  wrap.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div class="card-title" style="margin:0"><span class="icon icon-red">🔄</span>主动调仓建议 · ${suggestions.length} 条</div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px">同类基金中有评分高出15分以上的更优选择</div>
    </div>
    ${rows}
    <div style="padding:10px 14px;font-size:11px;color:var(--muted);background:#fafafa">⚠️ 换仓前请评估赎回费和持有天数，持有2年以上通常免赎回费。</div>
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
    const trendIcon = c.catTrend>=2?'🔥强势':c.catTrend>=0?'➡️平稳':'❄️弱势';
    return `<tr><td><b>${i+1}. ${escHtml(c.name)}</b></td><td>${chgText}</td>
      <td class="${c.avgR1>=0?'up':'down'}">${c.avgR1>=0?'+':''}${c.avgR1.toFixed(1)}%</td>
      <td class="${c.avgR3>=0?'up':'down'}">${c.avgR3>=0?'+':''}${c.avgR3.toFixed(1)}%</td>
      <td>${c.avgCalmar.toFixed(2)}</td><td>${trendIcon}</td></tr>`;
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

  if(summaryEl) summaryEl.textContent = chgAvailable
    ? `数据更新于 ${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}，基于精选库实时净值计算`
    : '净值数据未加载，今日涨跌暂不可用。点击「生成方案」可触发净值更新。';
}

// ═══════════════ 新手引导 ═══════════════
