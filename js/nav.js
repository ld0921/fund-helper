// ═══ 净值拉取模块 ═══
function fetchNav(code,cb){ navQ.push({code,cb}); drainQ(); }
function drainQ(){
  if(navBusy||!navQ.length) return;
  navBusy=true;
  const {code,cb}=navQ.shift(); let done=false;
  const t=setTimeout(()=>{ if(done)return; done=true; window.jsonpgz=()=>{}; navBusy=false; cb(null); setTimeout(drainQ,100); },8000);
  window.jsonpgz=(d)=>{ if(done)return; done=true; clearTimeout(t); navBusy=false; cb(d); setTimeout(drainQ,200); };
  const s=document.createElement('script');
  s.src=`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
  s.onerror=()=>{ if(done)return; done=true; clearTimeout(t); navBusy=false; cb(null); setTimeout(drainQ,200); };
  document.head.appendChild(s);
  setTimeout(()=>{ try{s.remove()}catch(e){} },5000);
}
function loadScript(url, timeout){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = url;
    const t = setTimeout(()=>{ try{s.remove()}catch(e){} reject(new Error('timeout')); }, timeout||10000);
    s.onload = ()=>{ clearTimeout(t); setTimeout(()=>{ try{s.remove()}catch(e){} },100); resolve(); };
    s.onerror = ()=>{ clearTimeout(t); try{s.remove()}catch(e){} reject(new Error('load error')); };
    document.head.appendChild(s);
  });
}
function updateNavCard(code,data){
  if(!data) return;
  navCache[code]={...data, fundcode: code};
  const el=document.getElementById(`nav-${code}`);
  const chgEl=document.getElementById(`chg-${code}`);
  const timeEl=document.getElementById(`time-${code}`);
  if(!el) return;
  // 判断是否为盘中估算：交易日9:30-11:30 / 13:00-15:00为交易时间
  const now=new Date();
  const h=now.getHours(), m=now.getMinutes(), day=now.getDay();
  const isMorning=(h===9&&m>=30)||h===10||(h===11&&m<30);
  const isAfternoon=h===13||h===14;
  const isTrading=day>=1&&day<=5&&(isMorning||isAfternoon);
  const navLabel=isTrading?'估':'实';
  const navStyle=isTrading?'border-bottom:1px dashed var(--muted)':'';
  el.textContent=data.gsz||data.dwjz||'--'; el.style.color=''; el.style.cssText=navStyle; el.title=isTrading?'盘中估算值，收盘后更新为实际净值':'已确认净值';
  const chg=parseFloat(data.gszzl), cls=chg>0?'up':chg<0?'down':'neutral';
  if(chgEl){ chgEl.textContent=isNaN(chg)?'--':`${chg>0?'+':''}${chg}%`; chgEl.className=`nav-change ${cls}`; }
  if(timeEl) timeEl.textContent=(isTrading?'⏳估 ':'✅实 ')+(data.gztime||data.jzrq||'');
}

// 核心：刷新持仓基金净值（只刷新用户持有的基金）
// 此函数已移至下方，与东方财富网数据合并逻辑整合

// 核心：自动加载净值 → 自动生成方案（刷新全部精选库基金，用于生成方案）
function refreshAllNav(autoGenerate, silent){
  if(autoGenerate===undefined) autoGenerate=true;
  if(silent===undefined) silent=false;
  const total=CURATED_FUNDS.length;
  let done=0;

  // 重置进度条
  const banner=document.getElementById('auto-banner');
  const bar=document.getElementById('progress-bar');
  const countEl=document.getElementById('banner-count');
  const textEl=document.getElementById('banner-text');
  if(!silent){
    banner.className=''; // show, loading style
    bar.style.width='0%';
    textEl.textContent='⏳ 正在更新实时净值…';
    countEl.textContent=`0 / ${total}`;
  }

  // 重置基金卡净值显示（仅非静默模式）
  if(!silent){
    CURATED_FUNDS.forEach(f=>{
      const el=document.getElementById(`nav-${f.code}`);
      if(el){el.textContent='加载中…'; el.style.color='var(--muted)';}
      const chgEl=document.getElementById(`chg-${f.code}`);
      if(chgEl){chgEl.textContent='--'; chgEl.className='nav-change neutral';}
    });
  }

  CURATED_FUNDS.forEach(f=>fetchNav(f.code, data=>{
    updateNavCard(f.code,data);
    done++;
    const pct=Math.round(done/total*100);
    if(!silent){
      bar.style.width=pct+'%';
      countEl.textContent=`${done} / ${total}`;
    }

    if(done===total){
      // 全部加载完成
      const now=new Date();
      const timeStr=`${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
      const successCount=Object.keys(navCache).length;
      if(!silent){
        textEl.textContent=`✅ 已获取 ${successCount} 只基金实时净值，更新于 ${timeStr}`;
        banner.className='done';
      }
      document.getElementById('nav-update-time').textContent=`净值更新于 ${timeStr}`;

      // 5秒后隐藏进度条
      if(!silent) setTimeout(()=>{ banner.className='hidden'; },5000);

      // 刷新定投排行榜
      renderDcaRanking();
      // 刷新持仓健康诊断
      runHealthMonitor();
      // 运行智能买卖信号引擎
      runSignalEngine();
      // 更新今日概览
      renderTodayOverview();

      // 自动生成投资方案
      if(autoGenerate){
        document.getElementById('gen-status').textContent=`已融合 ${successCount} 只基金实时数据，正在生成方案…`;
        setTimeout(()=>{
          _doGenerate();
          document.getElementById('gen-status').textContent=`方案已基于 ${timeStr} 实时数据生成`;
        }, 400);
      }
    }
  }));
}
let _navRefreshing = false;
async function refreshHoldingsNav(showToast_ = false){
  if(_navRefreshing){ console.log('[刷新净值] 已在刷新中，跳过'); return; }
  if(!existingHoldings.length){
    if(showToast_) showToast('暂无持仓数据','info');
    console.log('[刷新净值] 无持仓，跳过刷新');
    return;
  }
  _navRefreshing = true;
  const btn = document.getElementById('refresh-nav-btn');
  if(btn){ btn.textContent='⏳ 刷新中...'; btn.disabled=true; }

  // 1. 清理错误的navCache数据（键与fundcode不匹配）
  Object.keys(navCache).forEach(key => {
    if(navCache[key] && navCache[key].fundcode && navCache[key].fundcode !== key){
      console.warn(`[NavCache] 检测到错误数据: key=${key}, fundcode=${navCache[key].fundcode}，已删除`);
      delete navCache[key];
    }
  });

  let done = 0;
  const total = existingHoldings.length;

  for(const h of existingHoldings){
    // 2. 从fundgz获取实时估算数据
    fetchNav(h.code, async data => {
      const now = new Date();
      const today = now.toISOString().slice(0,10);
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();

      // 验证fundgz数据日期和时间
      if(data && data.gztime){
        const gztimeDate = data.gztime.slice(0,10);
        // 如果数据不是今天，或者市场未开盘，清空gszzl
        if(gztimeDate !== today || !isMarketOpen()){
          console.log(`[${h.code}] fundgz数据非今日或市场未开盘(${data.gztime})，清空gszzl`);
          data.gszzl = '0';
        }
      }
      if(data) navCache[h.code] = {...data, fundcode: h.code};

      // 3. 从东方财富网获取最新确认净值（补充）
      try {
        const eastmoneyNav = await fetchLatestNavFromEastmoney(h.code);
        if(eastmoneyNav){
          console.log(`[${h.code}] 东方财富网数据:`, eastmoneyNav);
          // 如果navCache不存在（fundgz失败），直接使用东方财富网数据
          if(!navCache[h.code]){
            console.log(`[${h.code}] fundgz无数据，使用东方财富网数据`);
            navCache[h.code] = {fundcode: h.code, name: h.name, ...eastmoneyNav};
          } else {
            // 验证东方财富网数据日期
            if(eastmoneyNav.jzrq !== today){
              console.log(`[${h.code}] 东方财富网数据非今日(${eastmoneyNav.jzrq})，保留fundgz估算`);
            } else {
              console.log(`[${h.code}] 合并东方财富网数据，gszzl: ${navCache[h.code].gszzl} -> ${eastmoneyNav.gszzl}`);
              navCache[h.code].dwjz = eastmoneyNav.dwjz;
              navCache[h.code].gsz = eastmoneyNav.gsz;
              navCache[h.code].gszzl = eastmoneyNav.gszzl;
              navCache[h.code].jzrq = eastmoneyNav.jzrq;
            }
          }
        } else {
          console.log(`[${h.code}] 东方财富网数据获取失败`);
        }
      } catch(e) {
        console.error(`[${h.code}] 东方财富网数据获取异常:`, e);
      }

      // 4. 在东方财富网数据合并完成后才计数和保存
      done++;
      if(done === total){
        navRefreshed = true;
        _navFreshThisSession = true;
        _navRefreshing = false;
        FundDB.set('navCache', navCache);
        FundDB.set('lastNavRefreshTime', Date.now());

        // 每次刷新净值后都检查是否需要更新昨日净值（函数内部会基于净值日期判断）
        await updateYesterdayNav();

        renderExistingHoldings(); runHealthMonitor(); renderTodayOverview();
        updateLastRefreshTime(); // 更新时间显示
        if(btn){ btn.textContent='🔄 刷新净值数据'; btn.disabled=false; }

        // 只在用户手动刷新时显示 toast
        if(showToast_){
          const hour2 = now.getHours();
          const minute2 = now.getMinutes();
          if(hour2 < 9 || (hour2 === 9 && minute2 < 30)){
            showToast('市场未开盘(9:30开盘)，今日收益数据暂不可用','info');
          } else {
            showToast(`已刷新 ${total} 只基金净值`,'success');
          }
        }
      }
    });
  }
}
