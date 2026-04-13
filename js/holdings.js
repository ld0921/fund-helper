// ═══ 持仓管理模块 ═══
function addExistingHolding(){
  const code=document.getElementById('eh-code').value.trim();
  const name=document.getElementById('eh-name').value.trim();
  const amount=parseFloat(document.getElementById('eh-amount').value)||0;
  const shares=parseFloat(document.getElementById('eh-shares').value)||0;
  const date=document.getElementById('eh-date').value||'';
  // 内联校验
  let hasErr=false;
  const searchEmpty = !code || !name;
  document.getElementById('eh-search').closest('.form-item').classList.toggle('has-error',searchEmpty);
  document.getElementById('eh-amount').closest('.form-item').classList.toggle('has-error',!amount||amount<=0);
  if(searchEmpty){showToast('请先搜索并选择一只基金','error');autoFadeErrors();return;}
  if(!amount||amount<=0){showToast('请填写买入金额','error');autoFadeErrors();return;}
  // 从navCache获取当前净值（优先使用确认净值dwjz）
  const nav = navCache[code];
  const curNav = nav ? parseFloat(nav.dwjz)||parseFloat(nav.gsz)||1 : 1;

  // 确认日期：15:00前→T+1（买入日+1天确认），15:00后→T+2（买入日+2天确认）
  const buyTime = (document.querySelector('input[name="eh-buytime"]:checked')||{}).value || 'before15';
  const buyDate = date ? new Date(date) : new Date();
  const confirmDate = new Date(buyDate);
  confirmDate.setDate(confirmDate.getDate() + (buyTime==='after15' ? 2 : 1));
  // 跳过周末和中国法定节假日
  while(!isCNTradingDay(confirmDate)) confirmDate.setDate(confirmDate.getDate()+1);
  const confirmDateStr = confirmDate.toISOString().slice(0,10);

  // 自动检测基金类型
  const fd = CURATED_FUNDS.find(f=>f.code===code);
  const type = fd ? fd.type : '股票型';

  // 计算买入成本净值
  let buyCost = curNav; // 默认使用当前净值估算
  let initialStatus = 'pending'; // 默认待确认
  if(shares > 0){
    // 如果用户输入了份额，反推真实买入净值，并直接设为已确认
    buyCost = amount / shares;
    initialStatus = 'confirmed';
  }

  const existing = existingHoldings.find(h=>h.code===code && h.status==='confirmed');
  if(existing && initialStatus === 'confirmed'){
    // 仅当新买入也是已确认状态时，才合并到已有的已确认持仓
    const oldAmount = existing.amount || 0;
    existing.amount = oldAmount + amount;
    existing.shares = (existing.shares || 0) + shares;
    existing.cost = existing.amount / existing.shares; // 加权平均成本
    // 使用当前确认净值计算市值
    const currentNav = nav ? parseFloat(nav.dwjz)||parseFloat(nav.gsz)||(existing.cost||curNav) : (existing.cost||curNav);
    existing.value = existing.shares && existing.shares > 0 ? existing.shares * currentNav : existing.amount;
    FundDB.set('existingHoldings',existingHoldings); markHoldingsChanged();
    addTransaction('buy', code, name, amount, shares);
    flashSaved('eh-section');
    renderExistingHoldings(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
    clearFundMatch('eh');
    document.getElementById('eh-amount').value='';
    document.getElementById('eh-shares').value='';
    showToast(`已加仓 ¥${amount.toLocaleString()} 到「${name}」，总买入 ¥${existing.amount.toLocaleString()}`,'success');
    return;
  }

  // 未确认的购买或首次购买：添加为独立持仓记录
  const newHolding = {code,name,amount,date:date||new Date().toISOString().slice(0,10),buyTime,status:initialStatus,confirmDate:confirmDateStr,type,cost:buyCost,value:amount};
  if(shares > 0){
    newHolding.shares = shares;
    // 使用当前确认净值计算市值
    const currentNav = nav ? parseFloat(nav.dwjz)||parseFloat(nav.gsz)||buyCost : buyCost;
    newHolding.value = shares * currentNav;
  }
  existingHoldings.push(newHolding);
  FundDB.set('existingHoldings',existingHoldings); markHoldingsChanged();
  addTransaction('buy', code, name, amount, shares);
  flashSaved('eh-section');
  // 立即获取该基金的净值数据，确保市值准确
  fetchNav(code, data => {
    if(data) navCache[code] = {...data, fundcode: code};
    renderExistingHoldings(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
  });
  clearFundMatch('eh');
  document.getElementById('eh-amount').value='';
  document.getElementById('eh-shares').value='';
  document.getElementById('eh-date').valueAsDate=new Date();
  showToast(`已添加持仓「${name}」¥${amount.toLocaleString()}${initialStatus==='confirmed'?'（已确认）':'（待确认）'}`,'success');
}
// 手动确认持仓份额（支付宝已确认后点击更新）
function confirmHolding(i){
  const h = existingHoldings[i];
  if(!h) return;
  openModal(`确认「${h.name}」的实际份额\n\n💡 为什么要确认份额？\n基金买入后需T+1或T+2确认，确认后才能计算准确的市值和收益。\n\n📋 在支付宝查看确认份额：\n支付宝 → 财富 → 基金 → 持仓 → 点击该基金 → 查看"持有份额"\n\n请输入确认的份额数：`, '', function(val){
    const shares = parseFloat(val);
    if(!shares || shares <= 0){ showToast('请输入有效份额数（可在支付宝持仓中查看）','error'); return; }
    h.status = 'confirmed';
    h.shares = shares;
    h.cost = h.amount / shares; // 确认净值 = 买入金额 / 确认份额

    // 检查是否存在相同基金代码的已确认持仓，如果存在则合并
    const existingIndex = existingHoldings.findIndex((x, idx) => idx !== i && x.code === h.code && x.status === 'confirmed');
    if(existingIndex !== -1){
      const existing = existingHoldings[existingIndex];
      // 合并：份额相加，金额相加，重新计算平均成本
      existing.shares += h.shares;
      existing.amount += h.amount;
      existing.cost = existing.amount / existing.shares;
      // 合并现金分红
      if(h.totalCashDividend) existing.totalCashDividend = (existing.totalCashDividend || 0) + h.totalCashDividend;
      // 删除当前记录
      existingHoldings.splice(i, 1);
      showToast(`${h.name} 已确认并合并：总份额${existing.shares.toFixed(4)}份`, 'success');
    } else {
      showToast(`${h.name} 已确认：${shares.toFixed(4)}份，确认净值${h.cost.toFixed(4)}`, 'success');
    }

    FundDB.set('existingHoldings', existingHoldings);
    renderExistingHoldings(); runHealthMonitor(); renderTodayOverview();
  });
}
function updateDividendShares(i){
  const h = existingHoldings[i];
  if(!h || !h.shares) { showToast('请先确认初始份额','error'); return; }
  // 先让用户选择分红方式
  const divType = confirm('请选择分红方式：\n\n点击「确定」= 红利再投资（份额增加）\n点击「取消」= 现金分红（记录分红金额）');
  if(divType){
    // 红利再投资：份额增加，成本不变
    openModal(`「${h.name}」红利再投资\n当前${h.shares.toFixed(4)}份，请输入分红后的新总份额\n\n📋 查看路径：支付宝→基金→持仓→查看"持有份额"`, h.shares.toFixed(4), function(val){
      const newShares = parseFloat(val);
      if(!newShares || newShares <= 0){ showToast('请输入有效份额数','error'); return; }
      if(newShares <= h.shares){ showToast('红利再投资后份额应增加，新份额应大于当前份额','error'); return; }
      const addedShares = newShares - h.shares;
      h.shares = newShares;
      FundDB.set('existingHoldings', existingHoldings);
      renderExistingHoldings(); runHealthMonitor(); renderTodayOverview();
      showToast(`红利再投资成功：新增${addedShares.toFixed(4)}份，当前共${newShares.toFixed(4)}份`,'success');
    });
  } else {
    // 现金分红：份额不变，记录分红金额（不影响持仓计算）
    openModal(`「${h.name}」现金分红\n请输入本次收到的分红金额(元)\n\n💡 现金分红不影响份额，分红金额已发放到余额宝`, '', function(val){
      const divAmt = parseFloat(val);
      if(!divAmt || divAmt <= 0){ showToast('请输入有效的分红金额','error'); return; }
      // 记录分红历史（不改变份额和成本）
      if(!h.dividendHistory) h.dividendHistory = [];
      h.dividendHistory.push({type:'cash', amount:divAmt, date:new Date().toISOString().slice(0,10)});
      h.totalCashDividend = (h.totalCashDividend||0) + divAmt;
      FundDB.set('existingHoldings', existingHoldings);
      renderExistingHoldings(); runHealthMonitor(); renderTodayOverview();
      showToast(`已记录现金分红 ¥${divAmt.toFixed(2)}，累计分红 ¥${h.totalCashDividend.toFixed(2)}`,'success');
    });
  }
}
function redeemHolding(i){
  const h = existingHoldings[i];
  if(!h) return;
  // 根据基金类型估算到账时间
  const fd=CURATED_FUNDS.find(f=>f.code===h.code);
  const cat=fd?fd.cat:(h.type||'');
  let arrivalTime='T+1确认，T+3-4到账';
  let arrivalDays = 4; // 默认4天到账
  if(cat==='money') { arrivalTime='快速赎回T+0(≤1万)，普通赎回T+1到账'; arrivalDays = 1; }
  else if(cat==='qdii') { arrivalTime='T+2-3确认，T+7-10到账'; arrivalDays = 10; }
  else if(cat==='bond') { arrivalTime='T+1确认，T+2-3到账'; arrivalDays = 3; }

  // 计算预计到账日期
  const arrivalDate = new Date();
  arrivalDate.setDate(arrivalDate.getDate() + arrivalDays);
  const arrivalDateStr = arrivalDate.toISOString().slice(0,10);

  const holdInfo=getHoldingDaysInfo(h.date, h.code);  const feeNote=holdInfo.fee!=='0%'?`\n⚠️ 当前赎回费率：${holdInfo.fee}（已持有${holdInfo.days}天）${holdInfo.nextTier?'\n💡 '+holdInfo.nextTier:''}`:'';
  const label = h.shares ? `当前${h.shares.toFixed(4)}份，输入要赎回的份额数` : `当前市值约¥${(h.value||0).toLocaleString()}，输入要赎回的金额`;
  openModal(`赎回「${h.name}」— ${label}\n\n⏱ 预计${arrivalTime}${feeNote}`, '', function(val){
    const redeemVal = parseFloat(val);
    if(!redeemVal || redeemVal <= 0){ showToast('请输入有效的赎回数量','error'); return; }
    if(h.shares && h.shares > 0){
      // 按份额赎回
      if(redeemVal >= h.shares){
        // 全部赎回 → 删除持仓
        const redeemAmount = h.value || 0;
        existingHoldings.splice(i, 1);
        addTransaction('redeem', h.code, h.name, redeemAmount, redeemVal, arrivalDateStr);
        showToast(`已全部赎回「${h.name}」，${arrivalTime}`,'success');
      } else {
        // 部分赎回
        const ratio = redeemVal / h.shares;
        const redeemAmount = h.value * ratio;
        h.shares -= redeemVal;
        h.amount = h.amount ? h.amount * (1 - ratio) : 0;
        h.value = h.value * (1 - ratio);
        addTransaction('redeem', h.code, h.name, redeemAmount, redeemVal, arrivalDateStr);
        showToast(`已赎回${redeemVal.toFixed(4)}份「${h.name}」，剩余${h.shares.toFixed(4)}份，${arrivalTime}`,'success');
      }
    } else {
      // 按金额赎回（未确认份额时）
      if(redeemVal >= (h.amount||h.value||0)){
        existingHoldings.splice(i, 1);
        addTransaction('redeem', h.code, h.name, redeemVal, 0, arrivalDateStr);
        showToast(`已全部赎回「${h.name}」，${arrivalTime}`,'success');
      } else {
        const ratio = redeemVal / (h.amount||h.value||1);
        h.amount = h.amount ? h.amount * (1 - ratio) : 0;
        h.value = (h.value||0) * (1 - ratio);
        addTransaction('redeem', h.code, h.name, redeemVal, 0, arrivalDateStr);
        showToast(`已赎回¥${redeemVal.toLocaleString()}「${h.name}」，${arrivalTime}`,'success');
      }
    }
    FundDB.set('existingHoldings', existingHoldings); markHoldingsChanged();
    renderExistingHoldings(); renderDcaPlans(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
  });
}
function removeExistingHolding(i){
  const h=existingHoldings[i];
  if(h && !confirm(`确定删除「${h.name||h.code}」？\n将同时删除该基金的定投计划。`)) return;
  const code = h ? h.code : null;
  existingHoldings.splice(i,1);
  FundDB.set('existingHoldings',existingHoldings); markHoldingsChanged();
  // 同时删除该基金的定投计划
  if(code){ dcaPlans = dcaPlans.filter(d=>d.code!==code); FundDB.set('dcaPlans',dcaPlans); }
  renderExistingHoldings(); renderDcaPlans(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
}
// refreshHoldingsNav 已移至 js/nav.js

async function updateYesterdayNav(){
  let yesterdayNav = await FundDB.get('yesterdayNav') || {};
  const today = new Date().toISOString().slice(0,10);

  // 计算昨日收益（在更新yesterdayNav之前）
  let yesterdayPnl = 0;
  let calculatedCount = 0;
  console.log('[昨日收益] 开始计算，持仓数量:', existingHoldings.length);
  existingHoldings.forEach(h => {
    const nav = navCache[h.code];
    const existing = yesterdayNav[h.code];
    if(!existing){
      console.log(`[昨日收益] ${h.code} 无yesterdayNav数据，跳过`);
    } else if(!nav || !nav.dwjz || !nav.jzrq){
      console.log(`[昨日收益] ${h.code} 无当前净值数据，跳过`);
    } else if(nav.jzrq <= existing.date){
      console.log(`[昨日收益] ${h.code} 净值日期未更新 (${nav.jzrq} <= ${existing.date})，跳过`);
    } else {
      const pnl = h.shares * (parseFloat(nav.dwjz) - existing.nav);
      console.log(`[昨日收益] ${h.code} 计算成功: ${h.shares}份 × (${nav.dwjz} - ${existing.nav}) = ¥${pnl.toFixed(2)}`);
      yesterdayPnl += pnl;
      calculatedCount++;
    }
  });

  console.log(`[昨日收益] 计算完成: ${calculatedCount}只基金, 总计¥${yesterdayPnl.toFixed(2)}`);

  // 存储昨日收益（只要有计算就存储）
  if(calculatedCount > 0){
    await FundDB.set('yesterdayPnl', { date: today, pnl: yesterdayPnl });
    console.log('[昨日收益] 已存储到数据库');
  }

  // 更新昨日净值
  existingHoldings.forEach(h => {
    const nav = navCache[h.code];
    const existing = yesterdayNav[h.code];
    // 只在净值日期 > 存储日期时更新
    if(nav && nav.dwjz && nav.jzrq && (!existing || !existing.date || nav.jzrq > existing.date)){
      yesterdayNav[h.code] = {
        date: nav.jzrq,
        nav: parseFloat(nav.dwjz)
      };
    }
  });

  await FundDB.set('yesterdayNav', yesterdayNav);
}

function filterHoldings(){
  renderExistingHoldings();
}

function updateBatchBar(){
  const checkboxes = document.querySelectorAll('.eh-checkbox:checked');
  const count = checkboxes.length;
  const bar = document.getElementById('eh-batch-bar');
  const countEl = document.getElementById('eh-batch-count');

  if(count > 0){
    bar.style.display = 'block';
    countEl.textContent = count;
  } else {
    bar.style.display = 'none';
  }
}

function toggleSelectAll(){
  const checkboxes = document.querySelectorAll('.eh-checkbox');
  const checkedCount = document.querySelectorAll('.eh-checkbox:checked').length;
  const shouldCheck = checkedCount < checkboxes.length;

  checkboxes.forEach(cb => cb.checked = shouldCheck);
  updateBatchBar();
}

async function batchDelete(){
  const checkboxes = document.querySelectorAll('.eh-checkbox:checked');
  if(checkboxes.length === 0) return;

  if(!confirm(`确定要删除选中的 ${checkboxes.length} 项持仓吗？`)) return;

  const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index)).sort((a,b) => b-a);

  for(const idx of indices){
    existingHoldings.splice(idx, 1);
  }

  await FundDB.set('existingHoldings', existingHoldings);
  renderExistingHoldings();
  clearSelection();
  showToast('已删除选中的持仓','success');
}

function clearSelection(){
  document.querySelectorAll('.eh-checkbox').forEach(cb => cb.checked = false);
  updateBatchBar();
}

async function addTransaction(type, fundCode, fundName, amount, shares = 0, arrivalDate = null){
  const transactions = await FundDB.get('transactions') || [];
  transactions.unshift({
    type,
    fundCode,
    fundName,
    amount,
    shares,
    date: new Date().toISOString().slice(0,10),
    timestamp: Date.now(),
    arrivalDate: arrivalDate || null,
    arrived: false
  });
  // 只保留最近100条记录
  if(transactions.length > 100) transactions.length = 100;
  await FundDB.set('transactions', transactions);
}

function clearExistingHoldings(){
  if(!existingHoldings.length||confirm('确定清空全部已有持仓？\n将同时清空所有定投计划。')){
    existingHoldings=[];
    dcaPlans=[];
    FundDB.set('existingHoldings',existingHoldings);
    FundDB.set('dcaPlans',dcaPlans);
    markHoldingsChanged();
    renderExistingHoldings(); renderDcaPlans(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
  }
}
// CN_HOLIDAYS 已移至 js/config.js
function isCNTradingDay(d){
  const day=d.getDay();
  if(day===0||day===6) return false;
  const str=d.toISOString().slice(0,10);
  if(CN_HOLIDAYS.has(str)) return false;
  return true;
}
// 持有天数 & 赎回费率提示
function getHoldingDaysInfo(dateStr, fundCode){
  if(!dateStr) return {days:0,fee:'--',tier:'',nextTier:''};
  const days=Math.floor((new Date()-new Date(dateStr))/86400000);
  const fd=CURATED_FUNDS.find(f=>f.code===fundCode);
  const cat=fd?fd.cat:'';
  const isC=fd&&fd.name&&fd.name.includes('C');
  let fee,tier,nextTier='';
  if(cat==='money'){
    // 货币基金：通常无赎回费
    fee='0%'; tier='货币基金免赎回费';
  } else if(isC){
    // C类份额：通常7天内1.5%，7天后0%
    if(days<7){ fee='1.50%'; tier='<7天'; nextTier=`再持${7-days}天降至0%`; }
    else { fee='0%'; tier='≥7天'; }
  } else if(cat==='bond'){
    // 债券基金：7天内1.5%，7天-30天0.1%，30天后通常0%
    if(days<7){ fee='1.50%'; tier='<7天'; nextTier=`再持${7-days}天降至0.10%`; }
    else if(days<30){ fee='0.10%'; tier='7-30天'; nextTier=`再持${30-days}天降至0%`; }
    else { fee='0%'; tier='≥30天'; }
  } else if(cat==='qdii'){
    // QDII：7天内1.5%，7天-1年0.5%，1-2年0.25%，2年+0%
    if(days<7){ fee='1.50%'; tier='<7天'; nextTier=`再持${7-days}天降至0.50%`; }
    else if(days<365){ fee='0.50%'; tier='7天-1年'; nextTier=`再持${365-days}天降至0.25%`; }
    else if(days<730){ fee='0.25%'; tier='1-2年'; nextTier=`再持${730-days}天降至0%`; }
    else { fee='0%'; tier='>2年'; }
  } else {
    // 股票/混合型：标准四档
    if(days<7){ fee='1.50%'; tier='<7天'; nextTier=`再持${7-days}天降至0.50%`; }
    else if(days<365){ fee='0.50%'; tier='7天-1年'; nextTier=`再持${365-days}天降至0.25%`; }
    else if(days<730){ fee='0.25%'; tier='1-2年'; nextTier=`再持${730-days}天降至0%`; }
    else { fee='0%'; tier='>2年'; }
  }
  return {days,fee,tier,nextTier};
}

// 判断是否是交易日（简化版：仅判断周末，不包含节假日）
// ═══════════════ 更新时间显示 ═══════════════
async function updateLastRefreshTime(){
  const lastRefreshTime = await FundDB.get('lastNavRefreshTime');
  const el = document.getElementById('last-update-time');
  if(!el) return;

  if(lastRefreshTime){
    const date = new Date(lastRefreshTime);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);

    let timeStr;
    if(minutes < 1){
      timeStr = '刚刚更新';
    } else if(minutes < 60){
      timeStr = `${minutes}分钟前更新`;
    } else {
      const hours = Math.floor(minutes / 60);
      if(hours < 24){
        timeStr = `${hours}小时前更新`;
      } else {
        timeStr = date.toLocaleString('zh-CN', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'});
      }
    }

    el.textContent = `📅 ${timeStr}`;
  } else {
    el.textContent = '尚未刷新';
  }
}

function isTradingDay(date = new Date()){
  const day = date.getDay();
  return day >= 1 && day <= 5; // 周一到周五
}

function isMarketOpen(date = new Date()){
  if(!isTradingDay(date)) return false;
  const hour = date.getHours();
  const minute = date.getMinutes();
  return hour > 9 || (hour === 9 && minute >= 30); // >= 9:30
}

function getNextTradingDay(){
  const next = new Date();
  next.setDate(next.getDate() + 1);
  while(!isTradingDay(next)){
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function updateNonTradingDayBanner(){
  const banner = document.getElementById('non-trading-day-banner');
  const btn = document.getElementById('refresh-nav-btn');
  if(!banner) return;

  if(!isTradingDay()){
    const next = getNextTradingDay();
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    const dateStr = `${next.getMonth()+1}月${next.getDate()}日（${weekdays[next.getDay()]}）`;
    document.getElementById('next-trading-day').textContent = dateStr;
    banner.style.display = 'block';

    // 更新刷新按钮状态
    if(btn){
      btn.innerHTML = '📅 非交易日（可刷新历史数据）';
      btn.style.background = '#d9d9d9';
      btn.style.boxShadow = 'none';
    }
  } else {
    banner.style.display = 'none';

    // 恢复刷新按钮状态
    if(btn){
      btn.innerHTML = '🔄 立即刷新';
      btn.style.background = 'linear-gradient(135deg,#1890ff,#096dd9)';
      btn.style.boxShadow = '0 2px 6px rgba(24,144,255,.3)';
    }
  }
}

async function renderExistingHoldings(){
  const list=document.getElementById('eh-list');
  const empty=document.getElementById('eh-empty');
  const summary=document.getElementById('eh-summary');

  // 自动合并相同基金代码的已确认持仓
  const codeMap = new Map();
  const toRemove = [];
  existingHoldings.forEach((h, idx) => {
    if(h.status === 'confirmed'){
      if(codeMap.has(h.code)){
        const firstIdx = codeMap.get(h.code);
        const first = existingHoldings[firstIdx];
        // 合并到第一条记录
        first.shares = (first.shares || 0) + (h.shares || 0);
        first.amount = (first.amount || 0) + (h.amount || 0);
        first.cost = first.shares > 0 ? first.amount / first.shares : first.cost;
        first.totalCashDividend = (first.totalCashDividend || 0) + (h.totalCashDividend || 0);
        // 标记当前记录为待删除
        toRemove.push(idx);
      } else {
        codeMap.set(h.code, idx);
      }
    }
  });
  // 删除重复记录（从后往前删除，避免索引变化）
  if(toRemove.length > 0){
    toRemove.reverse().forEach(idx => existingHoldings.splice(idx, 1));
    FundDB.set('existingHoldings', existingHoldings);
    // 合并后清空昨日净值数据，强制重新计算
    await FundDB.set('yesterdayNav', {});
    await FundDB.set('yesterdayPnl', {});
  }

  // 检查数据新鲜度，控制刷新横幅显示
  const lastRefreshTime = await FundDB.get('lastNavRefreshTime');
  const dataAge = lastRefreshTime ? Date.now() - lastRefreshTime : Infinity;
  const isDataStale = dataAge > 30 * 60 * 1000;

  // 获取昨日净值数据
  const yesterdayNav = await FundDB.get('yesterdayNav') || {};

  // 应用搜索和筛选
  let filteredHoldings = existingHoldings;
  const searchInput = document.getElementById('eh-filter-search');
  const statusSelect = document.getElementById('eh-filter-status');

  if(searchInput && searchInput.value.trim()){
    const keyword = searchInput.value.trim().toLowerCase();
    filteredHoldings = filteredHoldings.filter(h =>
      h.name.toLowerCase().includes(keyword) || h.code.includes(keyword)
    );
  }

  if(statusSelect && statusSelect.value !== 'all'){
    const status = statusSelect.value;
    filteredHoldings = filteredHoldings.filter(h =>
      status === 'confirmed' ? h.status === 'confirmed' : h.status !== 'confirmed'
    );
  }

  if(!existingHoldings.length){
    list.style.display='none'; empty.style.display='block'; summary.style.display='none';
    renderPortfolioOverview([], 0, 0, 0, 0, 0); // 清空收益总览
    return;
  }

  if(!filteredHoldings.length){
    list.innerHTML='<div style="padding:24px;text-align:center;color:var(--muted)">未找到匹配的基金</div>';
    list.style.display='block'; empty.style.display='none';
    return;
  }

  empty.style.display='none'; list.style.display='block';
  const today=new Date();
  const todayStr=today.toISOString().slice(0,10);
  // Auto-update status + calculate values
  filteredHoldings.forEach(h=>{
    // 状态不自动变更：到了确认日期时显示"待确认"提示用户手动确认
    // （因为实际确认时间以支付宝为准，工具无法自动获知）
    const nav=navCache[h.code];
    // 货币基金特殊处理：单位净值固定为1.00
    const fundInfo=CURATED_FUNDS.find(f=>f.code===h.code);
    const isMoneyFund=fundInfo&&(fundInfo.type==='货币型'||fundInfo.cat==='money');
    // 优先使用估算净值gsz，其次使用确认净值dwjz，最后用买入成本
    const curNav=isMoneyFund?1.00:(nav?parseFloat(nav.gsz)||parseFloat(nav.dwjz)||(h.cost||0):(h.cost||0));
    const cost=h.cost||curNav||0;
    if(h.shares && h.shares > 0){
      // 有份额数据：使用份额×净值计算市值（最准确）
      // 货币基金单位净值固定1.00，其他基金优先使用gsz（估算净值）
      const navVal = isMoneyFund ? 1.00 : (nav ? parseFloat(nav.gsz)||parseFloat(nav.dwjz)||(h.cost||0) : (h.cost||0));
      h.value = navVal > 0 ? h.shares * navVal : (h.value||h.amount||0);
    } else {
      // 无份额数据：用买入金额反推（不够准确）
      h.value=(h.amount && cost>0)?(h.amount/cost*curNav):(h.value||h.amount||0);
    }
  });
  FundDB.set('existingHoldings',existingHoldings);
  // 只统计已确认的持仓（与支付宝一致：确认中的不计入总资产）
  const confirmedHoldings=existingHoldings.filter(h=>h.status==='confirmed');
  const pendingHoldings=existingHoldings.filter(h=>h.status!=='confirmed');
  const totalCost=confirmedHoldings.reduce((s,h)=>s+(h.amount||0),0);
  const totalVal=confirmedHoldings.reduce((s,h)=>s+h.value,0);
  const totalCashDiv=confirmedHoldings.reduce((s,h)=>s+(h.totalCashDividend||0),0);
  const totalPnl=totalCost>0?(totalVal+totalCashDiv-totalCost):0;
  const totalPnlPct=totalCost>0?(totalPnl/totalCost*100):0;
  const pendingTotal=pendingHoldings.reduce((s,h)=>s+(h.amount||0),0);
  const isMobile=window.innerWidth<=600;

  // 待确认提醒横幅
  const reminderBanner = pendingHoldings.length > 0 ? `
    <div style="margin-bottom:12px;padding:12px 16px;background:linear-gradient(135deg,#e6f4ff,#bae0ff);border-radius:8px;border-left:4px solid #1677ff">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:18px">📌</span>
        <div style="flex:1">
          <div style="font-size:13px;color:#0958d9;font-weight:600">您有 ${pendingHoldings.length} 笔基金待确认</div>
          <div style="font-size:12px;color:#096dd9;margin-top:2px">请在支付宝查看确认份额后，点击「待确认」按钮输入份额完成确认</div>
        </div>
      </div>
    </div>
  ` : '';

  list.innerHTML=reminderBanner + filteredHoldings.map((h,i)=>{
    const fd=CURATED_FUNDS.find(f=>f.code===h.code);
    const cost=h.amount||0;
    const cashDiv=h.totalCashDividend||0;
    const pnlAmt=cost>0?(h.value+cashDiv-cost):null;
    const pnlPct=cost>0?(((h.value+cashDiv-cost)/cost)*100).toFixed(1):null;
    const pnlHtml=pnlAmt!=null?`<span class="${pnlAmt>=0?'up':'down'}">${pnlAmt>=0?'+':'-'}¥${Math.abs(pnlAmt).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})} (${pnlAmt>=0?'+':''}${pnlPct}%)</span>`:'<span style="color:var(--muted)">--</span>';
    const statusBadge = h.status==='confirmed'
      ? '<span style="font-size:11px;color:var(--success)">✅已确认</span>'
      : (todayStr >= (h.confirmDate||'')
        ? `<span style="font-size:12px;padding:4px 10px;background:linear-gradient(135deg,#e6f4ff,#bae0ff);color:#0958d9;border-radius:6px;cursor:pointer;font-weight:600;border:1px solid #91caff" onclick="confirmHolding(${i})" title="在支付宝→基金→持仓查看确认份额">📌 待确认 · 点击输入份额</span>`
        : (()=>{
            const today=new Date(todayStr);
            const confirmDay=new Date(h.confirmDate||todayStr);
            const diffDays=Math.ceil((confirmDay-today)/(1000*60*60*24));
            return `<span style="font-size:11px;color:var(--warning)">⏳确认中 · 预计${h.confirmDate||'--'}确认${diffDays>0?` (还有${diffDays}天)`:''}<br><span style="font-size:10px;color:var(--muted)">确认前不计入总资产</span></span>`;
          })());
    const sourceTag = h.source==='dca'
      ? '<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:#f9f0ff;color:#722ed1;border:1px solid #d3adf7;font-weight:500">📅 定投</span>'
      : '<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:#e6f4ff;color:#1677ff;border:1px solid #91caff;font-weight:500">💰 直购</span>';
    const nav = navCache[h.code];
    const yNav = yesterdayNav[h.code];

    // 使用昨日净值精确计算今日收益（仅交易日且已开盘）
    let todayChg = null, todayPnl = null, isEstimated = false;
    const today = new Date().toISOString().slice(0,10);
    // 货币基金特殊处理：单位净值固定1.00，今日盈亏接近0
    const fundInfo=CURATED_FUNDS.find(f=>f.code===h.code);
    const isMoneyFund=fundInfo&&(fundInfo.type==='货币型'||fundInfo.cat==='money');
    if(isMarketOpen() && isTradingDay() && navRefreshed && nav && h.shares && yNav){
      const currentNav = isMoneyFund ? 1.00 : (parseFloat(nav.gsz) || parseFloat(nav.dwjz) || 0);
      const yesterdayNavVal = isMoneyFund ? 1.00 : yNav.nav;
      todayPnl = h.shares * (currentNav - yesterdayNavVal);
      todayChg = yesterdayNavVal > 0 ? ((currentNav - yesterdayNavVal) / yesterdayNavVal * 100) : 0;
      isEstimated = nav.jzrq !== today; // 净值日期不是今天，说明是估算
    } else if(isMarketOpen() && isTradingDay() && navRefreshed && nav && h.value){
      // 降级方案：无昨日净值时使用估算涨跌幅
      todayChg = isMoneyFund ? 0 : (parseFloat(nav.gszzl)||0);
      todayPnl = h.value * todayChg / 100;
      isEstimated = nav.jzrq !== today;
    }
    const estTag = isEstimated ? '<span style="font-size:9px;color:var(--muted);margin-left:2px" title="盘中估算">估</span>' : '';
    const chgHtml = todayChg!==null ? `<div style="text-align:right"><div style="font-size:13px;font-weight:700;color:${todayChg>=0?'#cf1322':'#389e0d'}">${todayChg>=0?'+':''}${parseFloat(todayChg).toFixed(2)}%${estTag}</div>${todayPnl!==null?`<div style="font-size:11px;font-weight:600;color:${todayPnl>=0?'#cf1322':'#389e0d'};margin-top:1px">${todayPnl>=0?'+':''}¥${Math.abs(todayPnl).toFixed(2)}</div>`:''}</div>` : '';
    const isPending = h.status!=='confirmed';
    return `<div class="eh-row" ${isPending?'style="background:#e6f4ff;border-left:3px solid #91caff"':''}>
      <div style="display:flex;align-items:start;gap:8px">
        <input type="checkbox" class="eh-checkbox" data-index="${i}" onchange="updateBatchBar()" style="margin-top:4px;width:16px;height:16px;cursor:pointer">
        <div style="flex:1">
      <div class="eh-top">
        <div class="eh-fund-name">${escHtml(h.name)} ${sourceTag}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
        <code class="code-copy" onclick="copyCode('${escHtml(h.code)}',this)" title="点击复制" style="font-size:11px;color:var(--muted)">${escHtml(h.code)}</code>
        ${statusBadge}
        ${fd?`<span style="font-size:11px;color:var(--muted)">${escHtml(h.type||fd.type)}</span>`:''}
      </div>
      <div class="eh-stats">
        <div class="eh-stat" ${isPending?'style="background:#e6f4ff"':''}><div class="eh-stat-val">¥${(h.amount||0).toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:2})}</div><div class="eh-stat-lbl">买入成本</div></div>
        <div class="eh-stat" ${isPending?'style="background:#e6f4ff"':''}><div class="eh-stat-val" style="color:var(--primary)">¥${(h.value||0).toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:2})}</div><div class="eh-stat-lbl">当前市值</div></div>
        <div class="eh-stat" ${isPending?'style="background:#e6f4ff"':''}><div class="eh-stat-val ${pnlAmt!=null?(pnlAmt>=0?'up':'down'):''}">
          ${pnlAmt!=null?`${pnlAmt>=0?'+':''}${pnlPct}%`:'--'}</div><div class="eh-stat-lbl">盈亏</div></div>
        <div class="eh-stat" ${isPending?'style="background:#e6f4ff"':''}><div class="eh-stat-val ${todayChg!==null?(todayChg>=0?'up':'down'):''}">${todayChg!==null?`${todayChg>=0?'+':''}${parseFloat(todayChg).toFixed(2)}%${estTag}`:'--'}</div><div class="eh-stat-lbl">今日${todayPnl!==null?`<br><span style="font-size:9px">${todayPnl>=0?'+':''}¥${Math.abs(todayPnl).toFixed(2)}</span>`:''}</div></div>
      </div>
      <div class="eh-meta">${h.shares?`${h.shares.toFixed(4)}份 · `:''}${h.date||'--'} 买入${(()=>{const hi=getHoldingDaysInfo(h.date,h.code);return h.date?` · 已持有<b>${hi.days}</b>天 · 赎回费<b>${hi.fee}</b>${hi.nextTier?` <span style="color:var(--primary);font-size:10px">💡${hi.nextTier}</span>`:''}`:'';})()}${pnlAmt!=null?` · ${pnlAmt>=0?'盈利':'亏损'} ¥${Math.abs(pnlAmt).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`:''}${h.totalCashDividend?` · 累计分红 ¥${h.totalCashDividend.toFixed(2)}`:''}</div>
      <div class="eh-actions">
        <button class="fc-btn" onclick="redeemHolding(${i})">💰 赎回</button>
        ${h.status==='confirmed'&&h.shares?`<button class="fc-btn" onclick="updateDividendShares(${i})">📊 分红</button>`:''}
        <button class="fc-btn fc-danger" onclick="removeExistingHolding(${i})">🗑 删除</button>
      </div>
        </div>
      </div>
    </div>`;
  }).join('');
  // summary
  const pnlHtml2=totalCost>0?`&nbsp;·&nbsp;盈亏 <b class="${totalPnl>=0?'up':'down'}">${totalPnl>=0?'+':'-'}¥${Math.abs(totalPnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})} (${totalPnl>=0?'+':''}${totalPnlPct.toFixed(1)}%)</b>`:'';
  const pendingHtml=pendingTotal>0?`&nbsp;·&nbsp;<span style="color:var(--warning)">⏳确认中 ¥${pendingTotal.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>`:'';
  summary.style.display='block';
  summary.innerHTML=`💼 <b>${confirmedHoldings.length}</b> 只基金 · 总成本 <b>¥${totalCost.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</b> · 总市值 <b>¥${totalVal.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</b>${pnlHtml2}${pendingHtml}`;

  // 检查待确认提醒
  const needConfirm = existingHoldings.filter(h => h.status !== 'confirmed' && todayStr >= (h.confirmDate || ''));
  const reminderEl = document.getElementById('pending-confirm-reminder');
  if(reminderEl){
    if(needConfirm.length > 0){
      document.getElementById('pending-confirm-title').textContent = `您有 ${needConfirm.length} 笔持仓待确认`;
      document.getElementById('pending-confirm-desc').textContent = `基金已确认，请输入支付宝显示的持有份额以获得准确数据`;
      reminderEl.style.display = '';
    } else {
      reminderEl.style.display = 'none';
    }
  }

  // 渲染收益总览卡片
  renderPortfolioOverview(confirmedHoldings, totalCost, totalVal, totalPnl, totalPnlPct, pendingTotal);
  // 同步更新定投收益统计（定投专区）
  if(typeof renderDcaPnlSummary === 'function') renderDcaPnlSummary();
}

function scrollToFirstPending(){
  const todayStr = new Date().toISOString().slice(0,10);
  const firstPendingIdx = existingHoldings.findIndex(h => h.status !== 'confirmed' && todayStr >= (h.confirmDate || ''));
  if(firstPendingIdx >= 0){
    // 滚动到持仓列表
    const listEl = document.getElementById('eh-list');
    if(listEl){
      listEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // 延迟后触发第一个待确认项的确认操作
      setTimeout(() => confirmHolding(firstPendingIdx), 500);
    }
  }
}

async function renderPortfolioOverview(holdings, totalCost, totalVal, totalPnl, totalPnlPct, pendingTotal){
  const el = document.getElementById('portfolio-overview');
  if(!el) return;
  if(!holdings.length){ el.style.display='none'; return; }

  // 调试：输出待确认金额
  console.log('pendingTotal:', pendingTotal);

  // 获取最后刷新时间并检查数据新鲜度
  const lastRefreshTime = await FundDB.get('lastNavRefreshTime');
  const refreshTimeStr = lastRefreshTime ? new Date(lastRefreshTime).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'}) : '';
  const dataAge = lastRefreshTime ? Date.now() - lastRefreshTime : Infinity;
  const isDataStale = dataAge > 30 * 60 * 1000; // 超过30分钟视为过期

  // 如果数据过期，显示警告提示而不是错误的收益数据
  if(isDataStale || !navRefreshed){
    el.style.display='';
    el.innerHTML=`
      <div class="card" style="background:linear-gradient(135deg,#fffbe6,#fff7e6);border:1px solid #ffd591">
        <div class="card-title">
          <span class="icon icon-orange">⚠️</span>收益数据待刷新
        </div>
        <div style="font-size:13px;color:#d46b08;line-height:1.8;margin-bottom:12px">
          净值数据已过期（${refreshTimeStr ? '上次更新：' + refreshTimeStr : '未刷新'}），收益数据可能不准确。<br>
          请点击下方按钮刷新净值数据。
        </div>
        <div style="padding:12px;background:rgba(255,255,255,0.6);border-radius:8px;border:1px solid #ffd591">
          <div style="font-size:13px;color:#8c8c8c;margin-bottom:8px">📊 自动刷新策略</div>
          <div style="font-size:12px;color:#595959;line-height:1.8">
            • 登录后：如数据超过30分钟自动刷新<br>
            • 交易时段：每5分钟自动刷新一次<br>
            • 页面恢复：从后台切回时立即刷新<br>
            • 只刷新持仓基金，速度快（约3-5秒）
          </div>
        </div>
        <div style="text-align:center;margin-top:14px">
          <button class="btn btn-primary" onclick="refreshHoldingsNav(true)" style="font-size:14px;padding:10px 24px">
            🔄 立即刷新持仓净值
          </button>
        </div>
      </div>
    `;
    return;
  }

  // 获取昨日净值数据
  const yesterdayNav = await FundDB.get('yesterdayNav') || {};

  // 获取存储的昨日收益
  const yesterdayPnlData = await FundDB.get('yesterdayPnl') || {};
  const yesterdayPnl = yesterdayPnlData.pnl || 0;
  const hasYesterdayData = yesterdayPnlData.date && yesterdayPnlData.pnl !== undefined;

  // 今日涨跌 - 使用昨日净值精确计算（仅交易日且已开盘）
  let todayPnl=0, navCount=0;
  if(isTradingDay() && isMarketOpen() && navRefreshed){
    holdings.forEach(h=>{
      const nav=navCache[h.code];
      const yNav=yesterdayNav[h.code];
      // 货币基金特殊处理：单位净值固定1.00
      const fundInfo=CURATED_FUNDS.find(f=>f.code===h.code);
      const isMoneyFund=fundInfo&&(fundInfo.type==='货币型'||fundInfo.cat==='money');
      if(nav && h.shares && yNav){
        // 优先使用gsz(盘中估算)，其次dwjz(收盘确认)
        const currentNav = isMoneyFund ? 1.00 : (parseFloat(nav.gsz) || parseFloat(nav.dwjz) || 0);
        const yesterdayNavVal = isMoneyFund ? 1.00 : yNav.nav;
        todayPnl += h.shares * (currentNav - yesterdayNavVal);
        navCount++;
      } else if(nav && h.value){
        // 降级方案：无昨日净值时使用估算涨跌幅
        const chgPct=isMoneyFund ? 0 : (parseFloat(nav.gszzl)||0);
        todayPnl+=(h.value||0)*chgPct/100;
        navCount++;
      }
    });
  }

  // 检查昨天是否是交易日
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterdayTradingDay = isTradingDay(yesterday);

  // 估算本周/本月/本年收益（基于各基金1年收益率按比例折算）
  // 实际精确计算需要历史净值序列，这里用线性估算给用户参考
  let weekPnl=0, monthPnl=0, yearPnl=0, hasEstimate=false;
  holdings.forEach(h=>{
    const fd=CURATED_FUNDS.find(f=>f.code===h.code);
    if(fd && fd.r1!=null && h.value && h.value>0){
      const dailyR = fd.r1 / 365 / 100;
      weekPnl += h.value * dailyR * 5;   // ~5个交易日
      monthPnl += h.value * dailyR * 22;  // ~22个交易日
      yearPnl += h.value * fd.r1 / 100;
      hasEstimate = true;
    }
  });

  // 各基金盈亏明细（含现金分红）
  const details = holdings.map(h=>{
    const cost=h.amount||0;
    const cashDiv=h.totalCashDividend||0;
    const pnl=cost>0?((h.value||0)+cashDiv-cost):0;
    const pct=cost>0?(pnl/cost*100):0;
    const nav=navCache[h.code];
    const yNav=yesterdayNav[h.code];

    // 使用昨日净值精确计算今日收益（仅交易日且已开盘）
    let todayChg=null, todayPnl=null, isEstimated=false;
    const today=new Date().toISOString().slice(0,10);
    // 货币基金特殊处理：单位净值固定1.00
    const fundInfo=CURATED_FUNDS.find(f=>f.code===h.code);
    const isMoneyFund=fundInfo&&(fundInfo.type==='货币型'||fundInfo.cat==='money');
    if(isMarketOpen() && isTradingDay() && navRefreshed && nav && h.shares && yNav){
      const currentNav = isMoneyFund ? 1.00 : (parseFloat(nav.gsz) || parseFloat(nav.dwjz) || 0);
      const yesterdayNavVal = isMoneyFund ? 1.00 : yNav.nav;
      todayPnl = h.shares * (currentNav - yesterdayNavVal);
      todayChg = yesterdayNavVal > 0 ? ((currentNav - yesterdayNavVal) / yesterdayNavVal * 100) : 0;
      isEstimated = nav.jzrq !== today;
    } else if(isMarketOpen() && isTradingDay() && navRefreshed && nav && h.value){
      // 降级方案：无昨日净值时使用估算涨跌幅
      todayChg = isMoneyFund ? 0 : (parseFloat(nav.gszzl)||0);
      todayPnl = (h.value||0)*todayChg/100;
      isEstimated = nav.jzrq !== today;
    }

    return {name:h.name, code:h.code, cost, value:(h.value||0), pnl, pct, todayChg, todayPnl, isEstimated, source:h.source, shares:h.shares||0, date:h.date, jzrq:nav?.jzrq};
  }).sort((a,b)=>(b.value||0)-(a.value||0)); // 按市值降序

  // 按来源拆分收益：直购 vs 定投
  const dcaH = holdings.filter(h => h.source === 'dca');
  const directH = holdings.filter(h => h.source !== 'dca');
  const dcaCost = dcaH.reduce((s,h) => s + (h.amount||0), 0);
  const dcaVal = dcaH.reduce((s,h) => s + (h.value||0), 0);
  const dcaDiv = dcaH.reduce((s,h) => s + (h.totalCashDividend||0), 0);
  const dcaPnl = dcaCost > 0 ? (dcaVal + dcaDiv - dcaCost) : 0;
  const dcaPnlPct = dcaCost > 0 ? (dcaPnl / dcaCost * 100) : 0;
  const directCost = directH.reduce((s,h) => s + (h.amount||0), 0);
  const directVal = directH.reduce((s,h) => s + (h.value||0), 0);
  const directDiv = directH.reduce((s,h) => s + (h.totalCashDividend||0), 0);
  const directPnl = directCost > 0 ? (directVal + directDiv - directCost) : 0;
  const directPnlPct = directCost > 0 ? (directPnl / directCost * 100) : 0;
  const hasBothSources = dcaH.length > 0 && directH.length > 0;

  el.style.display='';
  el.innerHTML=`
    <div class="card">
      <div class="card-title">
        <span class="icon icon-green">💰</span>收益总览
        <button onclick="showProfitExplanation()" style="margin-left:6px;padding:2px 8px;font-size:11px;background:var(--primary-bg);color:var(--primary);border:1px solid var(--primary);border-radius:4px;cursor:pointer" title="收益指标说明">?</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="padding:12px;background:linear-gradient(135deg,#e6f7ff,#f0f5ff);border-radius:8px;border:1px solid #91d5ff">
            <div style="font-size:13px;color:#096dd9;margin-bottom:4px">总市值</div>
            <div style="font-size:22px;font-weight:700;color:#0050b3">¥${totalVal.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            ${pendingTotal>0?`<div style="margin-top:8px;padding:4px 10px;background:rgba(22,119,255,0.1);border-radius:12px;display:inline-block"><span style="font-size:12px;color:#1677ff">买入待确认 ${pendingTotal.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})} 元</span></div>`:''}
          </div>
          <div style="padding:12px;background:${totalPnl>=0?'linear-gradient(135deg,#fff1f0,#fff2f0)':'linear-gradient(135deg,#f6ffed,#f0fff4)'};border-radius:8px;border:1px solid ${totalPnl>=0?'#ffccc7':'#b7eb8f'}">
            <div style="font-size:13px;color:${totalPnl>=0?'#cf1322':'#389e0d'};margin-bottom:4px">累计盈亏</div>
            <div style="font-size:20px;font-weight:700;color:${totalPnl>=0?'#cf1322':'#389e0d'}">${totalPnl>=0?'+':''}¥${Math.abs(totalPnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
            <div style="font-size:14px;font-weight:600;color:${totalPnl>=0?'#cf1322':'#389e0d'};margin-top:2px">${totalPnl>=0?'+':''}${totalPnlPct.toFixed(1)}%</div>
            ${hasBothSources ? `<div style="margin-top:8px;padding:6px 8px;background:rgba(255,255,255,0.6);border-radius:6px;font-size:11px;line-height:1.8">
              <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:#1677ff">💰 直购</span><span class="${directPnl>=0?'up':'down'}" style="font-weight:600">${directPnl>=0?'+':''}¥${Math.abs(directPnl).toLocaleString('zh-CN',{maximumFractionDigits:2})} (${directPnl>=0?'+':''}${directPnlPct.toFixed(1)}%)</span></div>
              <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:#722ed1">📅 定投</span><span class="${dcaPnl>=0?'up':'down'}" style="font-weight:600">${dcaPnl>=0?'+':''}¥${Math.abs(dcaPnl).toLocaleString('zh-CN',{maximumFractionDigits:2})} (${dcaPnl>=0?'+':''}${dcaPnlPct.toFixed(1)}%)</span></div>
            </div>` : ''}
          </div>
          <div style="padding:12px;background:${navRefreshed&&todayPnl!==0?(todayPnl>=0?'linear-gradient(135deg,#fff1f0,#fff2f0)':'linear-gradient(135deg,#f6ffed,#f0fff4)'):'linear-gradient(135deg,#fafafa,#f5f5f5)'};border-radius:8px;border:1px solid ${navRefreshed&&todayPnl!==0?(todayPnl>=0?'#ffccc7':'#b7eb8f'):'#d9d9d9'}">
            <div style="font-size:13px;color:${navRefreshed&&todayPnl!==0?(todayPnl>=0?'#cf1322':'#389e0d'):'#8c8c8c'};margin-bottom:4px">实时盈亏${!isTradingDay()?'(非交易日)':(navRefreshed&&navCount>0?'':'(待刷新)')}</div>
            <div style="font-size:20px;font-weight:700;color:${navRefreshed&&todayPnl!==0?(todayPnl>=0?'#cf1322':'#389e0d'):'#8c8c8c'}">${!isTradingDay()?'--':(navRefreshed?(todayPnl>=0?'+':'')+'¥'+Math.abs(todayPnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'--')}</div>
            ${refreshTimeStr?`<div style="font-size:10px;color:var(--muted);margin-top:4px">📊 更新: ${refreshTimeStr}</div>`:''}
            <div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.5">
              ⚡ 自动刷新: 登录后自动 / 每5分钟 / 切回页面时
            </div>
          </div>
          <!-- 昨日收益暂时隐藏，计算逻辑需要优化
          <div style="padding:12px;background:${isYesterdayTradingDay&&hasYesterdayData?(yesterdayPnl>=0?'linear-gradient(135deg,#fff1f0,#fff2f0)':'linear-gradient(135deg,#f6ffed,#f0fff4)'):'linear-gradient(135deg,#fafafa,#f5f5f5)'};border-radius:8px;border:1px solid ${isYesterdayTradingDay&&hasYesterdayData?(yesterdayPnl>=0?'#ffccc7':'#b7eb8f'):'#d9d9d9'}">
            <div style="font-size:13px;color:${isYesterdayTradingDay&&hasYesterdayData?(yesterdayPnl>=0?'#cf1322':'#389e0d'):'#8c8c8c'};margin-bottom:4px">昨日收益${!isYesterdayTradingDay?'(非交易日)':''}</div>
            <div style="font-size:20px;font-weight:700;color:${isYesterdayTradingDay&&hasYesterdayData?(yesterdayPnl>=0?'#cf1322':'#389e0d'):'#8c8c8c'}">${isYesterdayTradingDay&&hasYesterdayData?(yesterdayPnl>=0?'+':'')+'¥'+Math.abs(yesterdayPnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'--'}</div>
          </div>
          -->
        </div>
        <div style="display:flex;align-items:center;justify-content:center;background:#fafafa;border-radius:8px;border:1px solid var(--border);padding:12px">
          <canvas id="portfolioPieChart" style="max-height:220px"></canvas>
        </div>
      </div>
      <div class="divider"></div>
      <details open>
        <summary style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:14px 16px;user-select:none;list-style:none;gap:8px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">各基金收益明细</div>
          </div>
          <span class="toggle-arrow" style="font-size:12px;color:var(--primary);flex-shrink:0"></span>
        </summary>
        <div style="border-top:1px solid #f0f0f0;padding:0 4px">
            ${details.map((d,idx)=>{
              const weight = totalVal > 0 ? (d.value / totalVal * 100) : 0;
              const pctStr=d.cost>0?`${d.pct>=0?'+':''}${d.pct.toFixed(1)}%`:'--';
              const pnlStr=d.cost>0?`${d.pnl>=0?'+':''}¥${Math.abs(d.pnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'--';
              const todayPctStr=d.todayChg!==null?`${d.todayChg>=0?'+':''}${parseFloat(d.todayChg).toFixed(2)}%`:'--';
              const todayPnlStr=d.todayPnl!==null?`${d.todayPnl>=0?'+':''}¥${Math.abs(d.todayPnl).toFixed(2)}`:'';
              const todayClass=d.todayChg!==null?(d.todayChg>=0?'up':'down'):'';
              const pnlClass=d.pnl>=0?'up':'down';
              const srcTag=d.source==='dca'?'<span style="font-size:9px;padding:1px 4px;border-radius:2px;background:#f9f0ff;color:#722ed1;border:1px solid #d3adf7;margin-left:4px">定投</span>':'<span style="font-size:9px;padding:1px 4px;border-radius:2px;background:#e6f4ff;color:#1677ff;border:1px solid #91caff;margin-left:4px">直购</span>';
              const today=new Date().toISOString().slice(0,10);
              const dateTag=d.jzrq&&d.jzrq!==today?`<span style="font-size:9px;padding:1px 4px;border-radius:2px;background:#fff7e6;color:#d48806;margin-left:4px">${d.jzrq.slice(5)}</span>`:'';
              const estTag=d.isEstimated?'<span style="font-size:9px;padding:1px 4px;border-radius:2px;background:#e6f7ff;color:#1890ff;margin-left:2px">估</span>':'';
              return `<div class="detail-row" style="${idx<details.length-1?'border-bottom:1px solid #f5f5f5':''}">
                <div class="detail-fund">
                  <div class="detail-fund-name">${escHtml(d.name)}${srcTag}${dateTag}</div>
                  <div class="detail-fund-meta">
                    <div class="detail-weight-bar"><div style="width:${Math.min(100,weight).toFixed(1)}%" class="detail-weight-fill"></div></div>
                    <span>${weight.toFixed(1)}%</span>
                    <span style="color:#d9d9d9">·</span>
                    <span>成本 ¥${d.cost.toLocaleString('zh-CN',{minimumFractionDigits:0,maximumFractionDigits:0})}</span>
                  </div>
                </div>
                <div class="detail-vals">
                  <div class="detail-val"><div class="detail-val-num">¥${d.value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="detail-val-lbl">当前市值</div></div>
                  <div class="detail-val"><div class="detail-val-num ${pnlClass}">${pnlStr}</div><div class="detail-val-lbl ${pnlClass}">${pctStr}</div></div>
                  <div class="detail-val"><div class="detail-val-num ${todayClass}">${todayPctStr}${estTag}</div><div class="detail-val-lbl ${todayClass}">${todayPnlStr}</div></div>
                  <div class="detail-val"><button onclick="showHistoryChart('${d.code}','${escHtml(d.name)}',${d.shares},'${d.date||''}',${d.pnl})" class="btn btn-sm" style="padding:4px 12px;font-size:11px">查看</button></div>
                </div>
              </div>`;
            }).join('')}
        </div>
      </details>
    </div>`;

  // 渲染饼图（确保单次渲染，避免重复加载）
  if(window.portfolioPieRenderTimer) clearTimeout(window.portfolioPieRenderTimer);
  window.portfolioPieRenderTimer = setTimeout(()=>{
    const canvas=document.getElementById('portfolioPieChart');
    if(!canvas) return;

    // 使用 requestAnimationFrame 确保布局稳定后再渲染
    requestAnimationFrame(()=>{
      const ctx=canvas.getContext('2d');
      if(window.portfolioPieChartInstance){
        window.portfolioPieChartInstance.destroy();
        window.portfolioPieChartInstance = null;
      }

      const chartData=details.slice(0,8).map(d=>({label:d.name,value:d.value,color:d.pnl>=0?'#52c41a':'#ff4d4f'}));
      const others=details.slice(8).reduce((s,d)=>s+d.value,0);
      if(others>0) chartData.push({label:'其他',value:others,color:'#d9d9d9'});

      const colors=['#1890ff','#52c41a','#faad14','#f5222d','#722ed1','#13c2c2','#eb2f96','#fa8c16','#d9d9d9'];
      window.portfolioPieChartInstance=new Chart(ctx,{
        type:'doughnut',
        data:{
          labels:chartData.map(d=>d.label),
          datasets:[{
            data:chartData.map(d=>d.value),
            backgroundColor:chartData.map((d,i)=>colors[i%colors.length]),
            borderWidth:2,
            borderColor:'#fff'
          }]
        },
        options:{
          responsive:true,
          maintainAspectRatio:true,
          animation:{duration:400},
          plugins:{
            legend:{display:true,position:'right',labels:{boxWidth:12,font:{size:11},padding:8}},
            tooltip:{
              callbacks:{
                label:ctx=>{
                  const val=ctx.parsed;
                  const pct=(val/totalVal*100).toFixed(1);
                  return `${ctx.label}: ¥${val.toLocaleString('zh-CN',{maximumFractionDigits:0})} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    });
  },500);
}
