// ═══ 智能组合模块 ═══
function calculateRebalanceCost(currentFund, targetFund, holdingDays, amount){
  // 赎回费率（基于持有天数）
  let redeemFee = 0;
  if(holdingDays < 7){
    redeemFee = 0.015; // 持有<7天：1.5%惩罚性费率
  } else if(holdingDays < 365){
    redeemFee = 0.005; // 7天-1年：0.5%
  } else if(holdingDays < 730){
    redeemFee = 0.0025; // 1-2年：0.25%
  } else {
    redeemFee = 0; // 2年以上：免赎回费
  }

  // 申购费率（支付宝1折，按类别）
  const purchaseFeeMap = {
    active: 0.0015,  // 主动型：0.15%
    index: 0.0012,   // 指数型：0.12%
    bond: 0.0008,    // 债券型：0.08%
    qdii: 0.0008,    // QDII：0.08%
    money: 0         // 货币型：0%
  };
  const purchaseFee = purchaseFeeMap[targetFund.cat] || 0.0015;

  // 总交易成本
  const totalCostRate = redeemFee + purchaseFee;
  const totalCostAmount = amount * totalCostRate;

  // 预期收益差（基于评分差异）
  const currentScore = scoreF(currentFund);
  const targetScore = scoreF(targetFund);
  const scoreDiff = targetScore - currentScore;

  // 假设：评分每差1分 ≈ 年化收益差0.15%（保守估计）
  const expectedGainRate = scoreDiff * 0.0015;
  const expectedGainAmount = amount * expectedGainRate;

  // 净收益 = 预期收益 - 交易成本
  const netGainAmount = expectedGainAmount - totalCostAmount;

  // 回本时间（年）
  const breakEvenYears = expectedGainRate > 0 ? totalCostRate / expectedGainRate : 999;

  return {
    redeemFee,
    purchaseFee,
    totalCostRate,
    totalCostAmount,
    expectedGainRate,
    expectedGainAmount,
    netGainAmount,
    breakEvenYears,
    worthIt: netGainAmount > 0 && breakEvenYears < 1.5 // 1.5 年内能回本才值得（2026-04 V2 回测证实月度换仓累计吞 3%/年，收紧门槛降低换手）
  };
}

// ═══════════════ 调仓算法 ═══════════════
function computeRebalancePlan(targetPicks, newMoney){
  if(!existingHoldings.length) return null;
  const allPicks=Object.values(targetPicks).flat();
  const existTotal=existingHoldings.reduce((s,h)=>s+h.value,0);
  const totalPortfolio=existTotal+newMoney;
  const actions=[];

  // 读取推荐历史，检测最近7天内推荐的基金
  let recentRecommends = [];
  try {
    const history = JSON.parse(localStorage.getItem('recommendHistory') || '[]');
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    recentRecommends = history.filter(h => new Date(h.date).getTime() > cutoff);
  } catch(e){ console.warn('读取推荐历史失败:', e); }

  // 目标基金：检查是否已持有
  allPicks.forEach(pick=>{
    // 特殊处理：如果是新买入的条目（isExisting=false），先检查用户是否实际持有该基金
    if(pick.isExisting === false){
      if(pick.amt <= 0) return; // 金额为0的新买入直接跳过
      const actualHeld = existingHoldings.find(h => h.code === pick.code);
      if(actualHeld){
        // 用户实际持有该基金，但评分未达保留阈值，按加仓逻辑处理
        const currentAmt = actualHeld.value;
        const targetAmt = pick.amt;
        const diff = targetAmt - currentAmt;
        const tol = Math.max(targetAmt * 0.10, 300);
        let action, actionAmt, actionDesc, actionColor;
        if(diff > tol){
          action='buy_more'; actionAmt=diff;
          actionDesc=`加仓 ¥${diff.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
          actionColor='act-buy_more';
        } else if(diff < -tol){
          const reduceAmt = Math.min(Math.abs(diff), currentAmt); // 不能超过持仓金额
          action='reduce'; actionAmt=reduceAmt;
          actionDesc=`减仓 ¥${reduceAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
          actionColor='act-reduce';
        } else {
          action='hold'; actionAmt=0;
          actionDesc='仓位合适，持有';
          actionColor='act-hold';
        }
        actions.push({code:pick.code, name:pick.name, type:pick.type, cat:pick.cat, r1:pick.r1,
          currentAmt, targetAmt, action, actionAmt, actionDesc, actionColor, manager:pick.manager});
        return;
      }
      const actionAmt = pick.amt;
      const actionDesc = `新建仓 ¥${actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
      actions.push({
        code:pick.code, name:pick.name, type:pick.type, cat:pick.cat, r1:pick.r1,
        currentAmt:0, targetAmt:actionAmt, action:'buy', actionAmt, actionDesc,
        actionColor:'act-buy', manager:pick.manager
      });
      return;
    }

    // 已有持仓的处理逻辑
    const held=existingHoldings.find(h=>h.code===pick.code);
    const currentAmt=held?held.value:0;
    const targetAmt=pick.amt; // 直接使用pick.amt作为目标金额
    // diff 始终基于 targetAmt - currentAmt，确保调仓金额与目标仓位一致
    const diff = targetAmt === 0 ? -currentAmt : (targetAmt - currentAmt);
    const tolPct = ['money','bond'].includes(pick.cat) ? 0.10 : pick.cat === 'index' ? 0.15 : 0.20;
    const tolMin = ['money','bond'].includes(pick.cat) ? 300 : pick.cat === 'index' ? 500 : 800;
    const tol = Math.max(targetAmt * tolPct, tolMin);
    let action,actionAmt,actionDesc,actionColor;
    if(targetAmt === 0 && currentAmt === 0) return;
    if(currentAmt===0){
      action='buy'; actionAmt=targetAmt;
      actionDesc=`新建仓 ¥${targetAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
      actionColor='act-buy';
    } else if(diff>tol && diff > 0){
      action='buy_more'; actionAmt=diff;
      actionDesc=`加仓 ¥${diff.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
      actionColor='act-buy_more';
    } else if(diff<-tol){
      // 持有成本感知：计算换仓净收益，只有划算时才建议减仓
      const held = existingHoldings.find(h=>h.code===pick.code);
      const holdingDays = held && held.date ? Math.floor((Date.now()-new Date(held.date).getTime())/86400000) : 365;
      const fd = CURATED_FUNDS.find(f=>f.code===pick.code);
      // 找同类最优基金作为换仓目标
      const sameCat = CURATED_FUNDS.filter(f=>f.cat===pick.cat && f.code!==pick.code);
      const bestAlt = sameCat.sort((a,b)=>scoreF(b)-scoreF(a))[0];
      let costWorthIt = true;
      if(fd && bestAlt && holdingDays < 730){
        const cost = calculateRebalanceCost(fd, bestAlt, holdingDays, Math.abs(diff));
        costWorthIt = cost.worthIt;
        if(!costWorthIt){
          action='hold'; actionAmt=0;
          actionDesc=`仓位略超配，但换仓成本${(cost.totalCostRate*100).toFixed(2)}%需${cost.breakEvenYears.toFixed(1)}年回本，建议持有`;
          actionColor='act-hold';
        }
      }
      if(costWorthIt){
        action='reduce'; actionAmt=Math.abs(diff);
        actionDesc=`减仓 ¥${Math.abs(diff).toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
        actionColor='act-reduce';
      }

      // 检测是否是最近推荐的基金需要大量减仓
      const recentRec = recentRecommends.find(r => r.code === pick.code);
      const reducePct = currentAmt > 0 ? (Math.abs(diff) / currentAmt * 100) : 0;
      if(recentRec && reducePct > 20){
        const daysSince = Math.floor((Date.now() - new Date(recentRec.date).getTime()) / (24*60*60*1000));
        action = 'reduce_gentle'; // 标记为需要温和处理
        actionDesc = `建议减仓 ¥${Math.abs(diff).toLocaleString('zh-CN',{maximumFractionDigits:0})}（${daysSince}天前推荐买入）`;
      }
    } else {
      action='hold'; actionAmt=0;
      actionDesc='仓位合适，持有';
      actionColor='act-hold';
    }

    // 构建action对象
    const actionObj = {code:pick.code,name:pick.name,type:pick.type,cat:pick.cat,r1:pick.r1,currentAmt,targetAmt,action,actionAmt,actionDesc,actionColor,manager:pick.manager};

    // 如果是温和减仓，添加额外信息
    if(action === 'reduce_gentle'){
      const recentRec = recentRecommends.find(r => r.code === pick.code);
      const daysSince = Math.floor((Date.now() - new Date(recentRec.date).getTime()) / (24*60*60*1000));
      const reducePct = currentAmt > 0 ? (Math.abs(diff) / currentAmt * 100) : 0;
      actionObj.gentleInfo = {
        daysSince,
        reducePct: Math.round(reducePct),
        recommendAmt: recentRec.amt,
        recommendDate: recentRec.date
      };
    }

    actions.push(actionObj);
  });

  // 用户持有但不在目标中的基金
  existingHoldings.forEach(h=>{
    const inTarget=allPicks.some(p=>p.code===h.code);
    if(inTarget) return;
    const fd=CURATED_FUNDS.find(f=>f.code===h.code);
    const r1=fd?fd.r1:null;
    let action,actionAmt,actionDesc,actionColor;

    // 按类别区分卖出阈值，避免一刀切
    // 权益类(active/index/qdii): r1<0 才建议卖
    // 债券类(bond): r1 < 类别均值-1σ 才建议卖
    // 货币类(money): 基本不建议卖
    const cat = fd ? fd.cat : 'other';
    const bench = _catBench[cat];
    let sellThreshold;
    if(cat === 'bond'){
      sellThreshold = bench ? bench.avgR1 - bench.stdR1 : 0;
    } else if(cat === 'money'){
      sellThreshold = -999; // 货币基金几乎不建议卖
    } else {
      sellThreshold = 0; // 权益类：近1年负收益才建议卖
    }

    // 计算持有天数（如果有购买日期）
    const holdingDays = h.date ? Math.floor((Date.now() - new Date(h.date).getTime()) / (1000*60*60*24)) : 365;

    // 交易成本优化：找到同类别中最好的推荐基金
    const sameCatTargets = allPicks.filter(p => p.cat === cat);
    const bestTarget = sameCatTargets.length > 0 ? sameCatTargets.sort((a,b) => scoreF(b) - scoreF(a))[0] : null;

    if(r1===null){
      action='satellite'; actionAmt=0;
      actionDesc='无法获取收益数据，建议人工确认后决定';
      actionColor='act-satellite';
    } else if(fd && fd.r3 < -20){
      // 近3年持续低迷，无论类别都建议卖出
      action='sell'; actionAmt=h.value;
      actionDesc=`不在核心组合内，近3年${fd.r3}%持续低迷，建议赎回转入推荐基金`;
      actionColor='act-sell';
    } else if(r1 < sellThreshold){
      // 计算换仓成本和收益
      if(fd && bestTarget && holdingDays < 365){
        const costAnalysis = calculateRebalanceCost(fd, bestTarget, holdingDays, h.value);
        if(!costAnalysis.worthIt){
          // 换仓不划算，改为观察
          action='satellite'; actionAmt=0;
          actionDesc=`近1年${r1}%低于阈值，但换仓成本${(costAnalysis.totalCostRate*100).toFixed(2)}%需${costAnalysis.breakEvenYears.toFixed(1)}年回本，建议继续观察`;
          actionColor='act-satellite';
        } else {
          action='sell'; actionAmt=h.value;
          actionDesc=`不在推荐组合内，近1年收益${r1}%低于同类阈值(${sellThreshold.toFixed(1)}%)，换仓成本${(costAnalysis.totalCostRate*100).toFixed(2)}%但${costAnalysis.breakEvenYears.toFixed(1)}年可回本，建议赎回`;
          actionColor='act-sell';
        }
      } else {
        action='sell'; actionAmt=h.value;
        actionDesc=`不在推荐组合内，近1年收益${r1}%低于同类阈值(${sellThreshold.toFixed(1)}%)，建议赎回`;
        actionColor='act-sell';
      }
    } else {
      action='satellite'; actionAmt=0;
      actionDesc=`非核心仓，近1年${r1}%，表现尚可，可作卫星仓继续持有观察`;
      actionColor='act-satellite';
    }
    actions.push({code:h.code,name:h.name,type:fd?.type||'--',cat:fd?.cat||'other',r1:r1??'--',currentAmt:h.value,targetAmt:action==='satellite'?h.value:0,action,actionAmt,actionDesc,actionColor,manager:fd?.manager||'--'});
  });

  // 优先级排序：卖出 → 减仓 → 温和减仓 → 新买 → 加仓 → 持有 → 卫星
  const order={sell:0,reduce:1,reduce_gentle:1.5,buy:2,buy_more:3,hold:4,satellite:5};
  actions.sort((a,b)=>(order[a.action]??9)-(order[b.action]??9));

  // 计算减持释放的资金
  const sellTotal = actions.filter(a=>a.action==='sell').reduce((s,a)=>s+a.actionAmt,0);
  const reduceTotal = actions.filter(a=>a.action==='reduce'||a.action==='reduce_gentle').reduce((s,a)=>s+a.actionAmt,0);
  const totalRelease = sellTotal + reduceTotal;

  // 资金平衡校验：买入总额应 ≈ 新增资金 + 减持释放
  // 当 hold/satellite 锁定部分资金使实际可用 < AI目标，按比例缩减并同步 pick.amt
  // 保证 AI方案显示 与 调仓建议 的目标仓位一致
  const buyActions = actions.filter(a=>['buy','buy_more'].includes(a.action));
  const actualBuyTotal = buyActions.reduce((s,a)=>s+a.actionAmt,0);
  const totalAvailable = newMoney + totalRelease;
  const syncPick = (code, amt) => {
    const pick = allPicks.find(p => p.code === code);
    if(pick){ pick.amt = amt; pick.pct = Math.round(amt / totalPortfolio * 100); }
  };
  if(buyActions.length > 0 && Math.abs(actualBuyTotal - totalAvailable) > 10){
    const diff = totalAvailable - actualBuyTotal;
    if(diff > 0){
      // 资金有剩余：加到最大买入操作上
      const maxBuy = [...buyActions].sort((a,b)=>b.actionAmt-a.actionAmt)[0];
      maxBuy.actionAmt += diff;
      maxBuy.targetAmt = maxBuy.currentAmt + maxBuy.actionAmt;
      syncPick(maxBuy.code, maxBuy.targetAmt);
      maxBuy.actionDesc = maxBuy.action==='buy'
        ? `新建仓 ¥${maxBuy.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`
        : `加仓 ¥${maxBuy.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
    } else {
      // 资金不足：按比例缩减所有买入操作，同步更新 AI方案 pick.amt/pct
      const scale = totalAvailable / actualBuyTotal;
      buyActions.forEach(a => {
        a.actionAmt = Math.max(0, Math.round(a.actionAmt * scale));
        a.targetAmt = a.currentAmt + a.actionAmt;
        syncPick(a.code, a.targetAmt);
        a.actionDesc = a.action==='buy'
          ? `新建仓 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`
          : `加仓 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
      });
      // 修正舍入误差：将差额加到最大买入操作
      const scaledTotal = buyActions.reduce((s,a)=>s+a.actionAmt,0);
      const remainder = totalAvailable - scaledTotal;
      if(Math.abs(remainder) > 0){
        const maxBuy = [...buyActions].sort((a,b)=>b.actionAmt-a.actionAmt)[0];
        maxBuy.actionAmt += remainder;
        maxBuy.targetAmt = maxBuy.currentAmt + maxBuy.actionAmt;
        syncPick(maxBuy.code, maxBuy.targetAmt);
        maxBuy.actionDesc = maxBuy.action==='buy'
          ? `新建仓 ¥${maxBuy.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`
          : `加仓 ¥${maxBuy.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
      }
    }
  }

  // 新建仓基金：targetAmt 始终等于 actionAmt（买多少就是目标仓位）
  buyActions.filter(a=>a.action==='buy').forEach(a=>{
    a.targetAmt = a.actionAmt;
    a.actionDesc = `新建仓 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
  });

  // 计算资金流动摘要
  const summary={
    existTotal, newMoney, totalPortfolio,
    sellAmt: sellTotal,
    reduceAmt: reduceTotal,
    buyAmt: buyActions.reduce((s,a)=>s+a.actionAmt,0),
  };
  summary.totalRelease = totalRelease;
  summary.flowBalance = newMoney + totalRelease - summary.buyAmt;

  return {actions,summary};
}

function renderRebalancePlan(plan){
  if(!plan){document.getElementById('rebal-card').style.display='none';return;}
  document.getElementById('rebal-card').style.display='block';
  const {summary,actions}=plan;
  const releaseAmt=summary.sellAmt+summary.reduceAmt;

  // 修复问题1和2：显示资金流动总览
  let summaryHtml = `
    <div class="rebal-sum-item"><div class="rebal-sum-val">¥${summary.existTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">当前持仓总值</div></div>
    <div class="rebal-sum-item"><div class="rebal-sum-val">¥${summary.newMoney.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">新增可投资金</div></div>
    <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--primary)">¥${summary.totalPortfolio.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">总目标组合规模</div></div>
    <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--danger)">¥${releaseAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">建议减持释放</div></div>
    <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--success)">¥${summary.buyAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">建议买入总额</div></div>`;

  document.getElementById('rebal-summary').innerHTML = summaryHtml;

  // 增加资金流动说明（先清除上一次生成的）
  const oldFlow = document.getElementById('rebal-flow-info');
  if(oldFlow) oldFlow.remove();
  if(releaseAmt > 0 || summary.newMoney > 0){
    const totalAvailable = summary.newMoney + releaseAmt;
    const flowBalance = summary.flowBalance || 0;
    const flowHtml = `<div id="rebal-flow-info" style="margin-top:12px;padding:10px 14px;background:#e6f7ff;border-radius:8px;border-left:3px solid var(--primary)">
      <div style="font-size:12px;font-weight:600;color:var(--primary);margin-bottom:6px">💰 资金流动说明</div>
      <div style="font-size:11px;color:#595959;line-height:1.8">
        ${releaseAmt > 0 ? `• 减持释放：¥${releaseAmt.toLocaleString()} （卖出 ¥${summary.sellAmt.toLocaleString()} + 减仓 ¥${summary.reduceAmt.toLocaleString()}）<br>` : ''}
        • 新增资金：¥${summary.newMoney.toLocaleString()}<br>
        • 可用总额：¥${totalAvailable.toLocaleString()}<br>
        • 建议买入：¥${summary.buyAmt.toLocaleString()}<br>
        ${Math.abs(flowBalance) > 1 ? `• 结余：¥${flowBalance.toLocaleString()}（${flowBalance > 0 ? '可继续投资或留作备用金' : '需补充资金'}）` : '• 资金刚好用完，无结余'}
      </div>
    </div>`;
    document.getElementById('rebal-summary').insertAdjacentHTML('afterend', flowHtml);
  }

  const actionIcons={sell:'🔴',reduce:'🟠',reduce_gentle:'🟡',buy:'🟢',buy_more:'🔵',hold:'⚪',satellite:'🟣'};
  const actionLabels={sell:'建议卖出',reduce:'建议减仓',reduce_gentle:'温和调整',buy:'建议新买',buy_more:'建议加仓',hold:'建议持有',satellite:'观察持仓'};
  document.getElementById('rebal-list').innerHTML=actions.map(a=>{
    // 温和减仓：显示特殊UI
    if(a.action === 'reduce_gentle' && a.gentleInfo){
      const g = a.gentleInfo;
      const riskP = document.getElementById('sp-risk')?.value || 'moderate';
      const horizon = parseInt(document.getElementById('sp-horizon')?.value) || 5;
      const riskNames = {conservative:'保守型',moderate:'稳健型',balanced:'平衡型',aggressive:'进取型'};

      // 计算逐步调整的效果
      const newMoney = parseFloat(document.getElementById('sp-amount')?.value) || 0;
      const afterAmt = a.currentAmt; // 保持不变
      const afterTotal = summary.existTotal + newMoney;
      const afterPct = afterTotal > 0 ? (afterAmt / afterTotal * 100) : 0;

      // 减仓原因分析
      const reasons = [];
      if(g.reducePct > 40) reasons.push(`当前${a.name}占总资产${Math.round(a.currentAmt/summary.existTotal*100)}%，建议降低到${Math.round(a.targetAmt/summary.totalPortfolio*100)}%`);
      reasons.push(`您的投资期限为${horizon}年，${horizon<=2?'短期':'长期'}投资建议${a.cat==='money'?'降低货币基金配置':'调整配置结构'}`);
      if(riskP !== 'conservative') reasons.push(`您的风险偏好为${riskNames[riskP]}，建议${a.cat==='money'?'增加权益类配置':'优化资产配置'}`);

      return `
        <div class="rebal-row" style="flex-direction:column;align-items:stretch;background:#fffbf0;border:1px solid #ffe58f;border-radius:10px;padding:14px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
            <div style="width:88px;flex-shrink:0"><span class="rebal-action act-reduce">${actionIcons[a.action]} ${actionLabels[a.action]}</span></div>
            <div class="rebal-fund" style="flex:1">
              <div class="rebal-fund-name">${escHtml(a.name)}</div>
              <div class="rebal-fund-meta">代码 ${escHtml(a.code)} · ${escHtml(a.type)} · ${g.daysSince}天前推荐买入 ¥${g.recommendAmt.toLocaleString()}</div>
            </div>
          </div>

          <div style="background:#fff;border-radius:8px;padding:12px;margin-bottom:10px">
            <div style="font-size:12px;font-weight:600;color:#ad6800;margin-bottom:6px">📊 减仓原因</div>
            <div style="font-size:12px;color:#595959;line-height:1.7">${reasons.map(r=>`• ${r}`).join('<br>')}</div>
          </div>

          <div style="font-size:12px;font-weight:600;color:#ad6800;margin-bottom:8px">💡 两种调整方案</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="background:#fff;border:1.5px solid #ffa39e;border-radius:8px;padding:10px">
              <div style="font-size:12px;font-weight:600;color:#cf1322;margin-bottom:6px">方案A：立即减仓</div>
              <div style="font-size:11px;color:#595959;line-height:1.6;margin-bottom:8px">
                • 操作：赎回 ¥${a.actionAmt.toLocaleString()}<br>
                • 优点：快速达到目标配置<br>
                • 缺点：产生交易成本（赎回费约¥${Math.round(a.actionAmt*0.005)}-${Math.round(a.actionAmt*0.015)}）
              </div>
              <div style="font-size:11px;color:var(--muted)">适合：急需资金或市场环境剧变</div>
            </div>

            <div style="background:#f6ffed;border:1.5px solid #95de64;border-radius:8px;padding:10px">
              <div style="font-size:12px;font-weight:600;color:#237804;margin-bottom:6px">方案B：逐步调整 ✓推荐</div>
              <div style="font-size:11px;color:#595959;line-height:1.6;margin-bottom:8px">
                • 操作：保持当前持仓不动，新资金不买此基金<br>
                • 效果：占比将从${Math.round(a.currentAmt/summary.existTotal*100)}%降至${Math.round(afterPct)}%<br>
                • 优点：无交易成本，平滑过渡
              </div>
              <div style="font-size:11px;color:var(--muted)">适合：正常情况（推荐）</div>
            </div>
          </div>
        </div>`;
    }

    // 普通action：使用原有渲染逻辑
    return `
    <div class="rebal-row">
      <div style="width:88px;flex-shrink:0"><span class="rebal-action ${a.actionColor}">${actionIcons[a.action]} ${actionLabels[a.action]}</span></div>
      <div class="rebal-fund">
        <div class="rebal-fund-name">${escHtml(a.name)}</div>
        <div class="rebal-fund-meta">代码 ${escHtml(a.code)} · ${escHtml(a.type)} · ${escHtml(a.manager)} · 近1年 <span class="${(+a.r1)>=0?'up':'down'}">${(+a.r1)>=0?'+':''}${a.r1}%</span></div>
        <div class="rebal-fund-desc">${escHtml(a.actionDesc)}</div>
      </div>
      <div class="rebal-amts">
        <div class="rebal-amt"><div class="rebal-amt-val">¥${a.currentAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-amt-lbl">当前持仓</div></div>
        <div class="rebal-arrow">→</div>
        <div class="rebal-amt"><div class="rebal-amt-val" style="color:var(--primary)">¥${Math.max(0, a.targetAmt).toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-amt-lbl">目标仓位</div></div>
        <div class="rebal-amt"><div class="rebal-amt-val" style="color:${['sell','reduce','reduce_gentle'].includes(a.action)?'var(--danger)':['buy','buy_more'].includes(a.action)?'var(--success)':'var(--muted)'}">${a.actionAmt>0?(['sell','reduce','reduce_gentle'].includes(a.action)?'-':'+')+'\u00A5'+a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0}):'--'}</div><div class="rebal-amt-lbl">调仓金额</div></div>
      </div>
    </div>`}).join('');
}

// ═══════════════ 面板1: AI智能组合规划 ═══════════════

// CAT_COLORS、CAT_NAMES 已移至 js/config.js
// analyzeCategoryPerf、inferMomentumPhase、detectManagerChanges 已移至 js/market.js

// 根据档案 & 行情 & 市场动量 生成配置权重（风险平价 + 动量约束 + 动态倾斜 + 期限约束）
function computeWeights(riskProfile, horizon, catRanks, macroClock){
  // 1. 风险平价基础权重：优先用 monthlyReturns 真实标准差，兜底用 avgDD/DD_TO_VOL
  const catVol = {};
  const volFloor = {active:1.0, index:1.0, bond:0.5, money:0.2, qdii:1.0};
  catRanks.forEach(c => {
    const mr = MARKET_BENCHMARKS[c.cat] && MARKET_BENCHMARKS[c.cat].monthlyReturns;
    if(mr && mr.length >= 6){
      const mean = mr.reduce((s,v)=>s+v,0)/mr.length;
      const std = Math.sqrt(mr.reduce((s,v)=>s+(v-mean)**2,0)/mr.length);
      catVol[c.cat] = Math.max(std, volFloor[c.cat]||0.5);
    } else {
      catVol[c.cat] = Math.max(c.avgDD / (DD_TO_VOL[c.cat]||2.5), volFloor[c.cat]||0.5);
    }
  });

  // 相关性矩阵：优先从 MARKET_BENCHMARKS 月度序列动态计算，兜底用历史经验值
  const _corrFallback = {
    active: { active:1.00, index:0.92, bond:-0.15, money:0.05, qdii:0.65 },
    index:  { active:0.92, index:1.00, bond:-0.10, money:0.05, qdii:0.70 },
    bond:   { active:-0.15, index:-0.10, bond:1.00, money:0.20, qdii:-0.05 },
    money:  { active:0.05, index:0.05, bond:0.20, money:1.00, qdii:0.05 },
    qdii:   { active:0.65, index:0.70, bond:-0.05, money:0.05, qdii:1.00 }
  };
  const cats5 = ['active','index','bond','money','qdii'];
  const _mbSeqs = {};
  cats5.forEach(c => { if(MARKET_BENCHMARKS[c] && MARKET_BENCHMARKS[c].monthlyReturns && MARKET_BENCHMARKS[c].monthlyReturns.length >= 6) _mbSeqs[c] = MARKET_BENCHMARKS[c].monthlyReturns; });
  const _seqCats = cats5.filter(c => _mbSeqs[c]);
  const corrMatrix = JSON.parse(JSON.stringify(_corrFallback)); // 先复制兜底值
  if(_seqCats.length >= 2){
    console.log('[相关性矩阵] 使用动态计算（月度序列长度:', _seqCats.map(c=>`${c}:${_mbSeqs[c].length}`).join(', '), ')');
    _seqCats.forEach(ci => {
      _seqCats.forEach(cj => {
        if(ci === cj){ corrMatrix[ci][cj] = 1.00; return; }
        const a = _mbSeqs[ci], b = _mbSeqs[cj];
        const n = Math.min(a.length, b.length);
        const ma = a.slice(0,n).reduce((s,v)=>s+v,0)/n;
        const mb2 = b.slice(0,n).reduce((s,v)=>s+v,0)/n;
        let num=0, da=0, db=0;
        for(let i=0;i<n;i++){ num+=(a[i]-ma)*(b[i]-mb2); da+=(a[i]-ma)**2; db+=(b[i]-mb2)**2; }
        const corr = (da>0&&db>0) ? Math.max(-1, Math.min(1, num/Math.sqrt(da*db))) : _corrFallback[ci][cj];
        corrMatrix[ci][cj] = Math.round(corr*100)/100;
      });
    });
  }

  // 简化的风险平价：使用迭代法求解等风险贡献
  // 初始权重：1/波动率
  const invVols = {};
  let invVolSum = 0;
  catRanks.forEach(c => {
    invVols[c.cat] = 1 / catVol[c.cat];
    invVolSum += invVols[c.cat];
  });

  // 初始权重
  let weights = {};
  catRanks.forEach(c => { weights[c.cat] = invVols[c.cat] / invVolSum; });

  // 迭代优化：调整权重使风险贡献更均衡（最多10次迭代）
  for(let iter = 0; iter < 10; iter++){
    // 计算每个资产的边际风险贡献 MRC_i = w_i × (Σw)_i
    const mrc = {};
    const cats = Object.keys(weights);

    cats.forEach(i => {
      let sum = 0;
      cats.forEach(j => {
        const corr = (corrMatrix[i] && corrMatrix[i][j] !== undefined) ? corrMatrix[i][j] : 0.3;
        sum += weights[j] * corr * catVol[i] * catVol[j];
      });
      mrc[i] = weights[i] * sum;
    });

    // 计算总风险贡献
    const totalMRC = Object.values(mrc).reduce((s,v) => s+v, 0);
    if(totalMRC === 0) break;

    // 目标：每个资产的风险贡献 = 总风险 / 资产数量
    const targetMRC = totalMRC / cats.length;

    // 调整权重：如果风险贡献过高，降低权重；过低则提高权重
    let newWeights = {};
    cats.forEach(cat => {
      const ratio = targetMRC / (mrc[cat] || 1);
      newWeights[cat] = weights[cat] * Math.pow(ratio, 0.5); // 使用平方根缓和调整
    });

    // 归一化
    const sumW = Object.values(newWeights).reduce((s,v) => s+v, 0);
    cats.forEach(cat => { newWeights[cat] = newWeights[cat] / sumW; });

    // 检查收敛
    let maxChange = 0;
    cats.forEach(cat => {
      maxChange = Math.max(maxChange, Math.abs(newWeights[cat] - weights[cat]));
    });

    weights = newWeights;

    if(maxChange < 0.001) break; // 收敛
  }

  // 转换为百分比
  const rpWeights = {};
  catRanks.forEach(c => { rpWeights[c.cat] = (weights[c.cat] || 0) * 100; });

  // 2. 风险偏好倾斜系数（在风险平价基础上调整）
  const tiltFactors = {
    conservative: { money:1.6, bond:1.4, index:0.6, active:0.6, qdii:0.4 },
    moderate:     { money:0.9, bond:1.0, index:1.2, active:0.8, qdii:0.9 },
    balanced:     { money:0.5, bond:0.7, index:1.1, active:1.3, qdii:1.1 },
    aggressive:   { money:0.2, bond:0.3, index:1.0, active:1.5, qdii:1.4 },
  }[riskProfile];

  // 2.5 投资期限主动倾斜（叠加在风险偏好之上）
  // 短期降权益提稳健，长期提权益追复利
  const horizonFactors =
    horizon <= 1  ? { money:1.5, bond:1.3, index:0.5, active:0.5, qdii:0.4 } :
    horizon <= 2  ? { money:1.2, bond:1.1, index:0.8, active:0.8, qdii:0.7 } :
    horizon <= 3  ? { money:1.0, bond:1.0, index:1.0, active:1.0, qdii:1.0 } :
    horizon <= 5  ? { money:0.8, bond:0.9, index:1.1, active:1.2, qdii:1.1 } :
                    { money:0.5, bond:0.8, index:1.2, active:1.4, qdii:1.3 };

  const base = {};
  let tiltSum = 0;
  catRanks.forEach(c => {
    base[c.cat] = rpWeights[c.cat] * (tiltFactors[c.cat] || 1) * (horizonFactors[c.cat] || 1);
    tiltSum += base[c.cat];
  });
  // 归一化
  Object.keys(base).forEach(k => base[k] = base[k] / tiltSum * 100);

  // 保守型期限保底：投资期限≥3年时，确保至少5%权益敞口（防止购买力侵蚀）
  if(riskProfile === 'conservative' && horizon >= 3){
    const equityTotal = (base.active||0) + (base.index||0);
    if(equityTotal < 5){
      const deficit = 5 - equityTotal;
      base.index = (base.index||0) + deficit;
      base.bond = Math.max(0, (base.bond||0) - deficit);
    }
  }

  // 3. 市场动量约束（基于资产相对强弱的顶层调整）
  if(macroClock && macroClock.phase !== 'unknown'){
    const eqMult = macroClock.equityMult;
    const bdMult = macroClock.bondMult;
    ['active','index','qdii'].forEach(c => { if(base[c]) base[c] *= eqMult; });
    if(base.bond) base.bond *= bdMult;
    // 滞胀期强制提升货币配置
    if(macroClock.phase === 'stagflation'){
      base.money = Math.max(base.money || 0, 15);
    }
    // QDII机会期：适度提升QDII配置
    if(macroClock.phase === 'qdii_opp' || macroClock.phase === 'global_bull'){
      if(base.qdii) base.qdii *= 1.2;
    }
    // 重新归一化
    const macroTotal = Object.values(base).reduce((s,v)=>s+v,0);
    Object.keys(base).forEach(k => base[k] = base[k] / macroTotal * 100);
  }

  // 4. 动量倾斜：基于类别行情强弱适当调整（含反转保护）
  const maxTilt = { conservative:5, moderate:8, balanced:15, aggressive:15 }[riskProfile];
  if(catRanks.length >= 2){
    const top = catRanks[0].cat;
    const bottom = catRanks[catRanks.length-1].cat;
    const scoreRange = catRanks[0].catScore - catRanks[catRanks.length-1].catScore;
    if(scoreRange > 0){
      // 反转保护1：若该类别已被动量信号调高（equityMult>1），动量倾斜减半，防止双重追涨
      const topAlreadyBoosted = macroClock && macroClock.equityMult > 1 && ['active','index','qdii'].includes(top);
      const tiltScale = topAlreadyBoosted ? 0.5 : 1.0;
      const topCatData = catRanks[0];
      // 固定幅度倾斜：强势类别+maxTilt，避免 scoreRange 量纲不稳定
      let effectiveTilt = Math.round(maxTilt * tiltScale);
      if(topCatData.avgR1 > 40){
        effectiveTilt = -Math.round(maxTilt * 0.3);
      } else if(topCatData.avgR1 > 30){
        effectiveTilt = 0;
      }
      const trimAmt = Math.round(maxTilt * 0.5 * tiltScale);
      // 反转保护3：弱势类别若已跌较深(avgR1<-10%)，可能是底部区域，不再减配
      const bottomCatData = catRanks[catRanks.length-1];
      const effectiveTrim = bottomCatData.avgR1 < -10 ? 0 : trimAmt;

      if(effectiveTilt > 0) base[top] = Math.min(base[top] + effectiveTilt, 55);
      else if(effectiveTilt < 0) base[top] = Math.max(base[top] + effectiveTilt, 5);
      base[bottom] = Math.max(base[bottom] - effectiveTrim, 2);
      // 第二强势类别也小幅加仓（同样受反转保护）
      if(effectiveTilt > 0){
        const second = catRanks[1].cat;
        if(second !== top) base[second] = Math.min(base[second] + Math.round(effectiveTilt * 0.3), 45);
      }
    }
  }

  // 5. 投资期限约束（权益类上限）
  // 期限越长允许越多权益敞口
  const equityCap = horizon >= 10 ? 85 : horizon >= 5 ? 75 : horizon >= 3 ? 65 : horizon >= 2 ? 60 : 30;
  const equityCats = ['active','index','qdii'];
  let equityTotal = equityCats.reduce((s,c) => s + (base[c]||0), 0);
  if(equityTotal > equityCap){
    const scale = equityCap / equityTotal;
    equityCats.forEach(c => { if(base[c]) base[c] *= scale; });
    // 释放的权重分配给债券和货币
    const freed = equityTotal - equityCap;
    base.bond = (base.bond||0) + freed * 0.6;
    base.money = (base.money||0) + freed * 0.4;
  }

  // 6. 短期额外调整
  if(horizon <= 1){
    base.active = Math.max((base.active||0) - 5, 0);
    base.bond = (base.bond||0) + 5;
  }

  // 6.5 风险偏好权益下限保障（防止风险平价稀释效应，不超过equityCap）
  // 下限对齐文字说明：稳健20%、平衡40%、进取60%（短期进取受equityCap约束取较小值）
  const equityFloorBase = { conservative:0, moderate:20, balanced:40, aggressive:60 }[riskProfile] || 0;
  const equityFloor = Math.min(equityFloorBase, equityCap);
  if(equityFloor > 0){
    let eq = equityCats.reduce((s,c) => s + (base[c]||0), 0);
    if(eq < equityFloor){
      const deficit = equityFloor - eq;
      // 优先从货币基金扣减，其次债券
      const fromMoney = Math.min(base.money||0, deficit);
      base.money = (base.money||0) - fromMoney;
      const fromBond = Math.min(base.bond||0, deficit - fromMoney);
      base.bond = (base.bond||0) - fromBond;
      // 按 active:index:qdii = 3:2:1 补充权益
      const add = fromMoney + fromBond;
      base.active = (base.active||0) + add * 0.5;
      base.index  = (base.index||0)  + add * 0.33;
      base.qdii   = (base.qdii||0)   + add * 0.17;
    }
  }

  // 7. 归一化到100 + 修正舍入
  const total = Object.values(base).reduce((s,v)=>s+v,0);
  Object.keys(base).forEach(k => base[k] = Math.round(base[k] / total * 100));
  const diff = 100 - Object.values(base).reduce((s,v)=>s+v,0);
  if(diff !== 0){
    const k = Object.keys(base).sort((a,b) => base[b] - base[a])[0];
    base[k] += diff;
  }

  // 最低权重：仅对该偏好的核心类别保底，非核心类别允许为0
  // 保守型核心=货币+债券，进取型核心=主动+指数+QDII
  const coreCats = {
    conservative: ['money','bond'],
    moderate:     ['money','bond','index'],
    balanced:     ['bond','index','active'],
    aggressive:   ['active','index','qdii'],
  }[riskProfile] || Object.keys(base);
  Object.keys(base).forEach(k => {
    if(coreCats.includes(k) && base[k] < 2) base[k] = 2;
    else if(!coreCats.includes(k) && base[k] < 1) base[k] = 0; // 非核心类别可清零
  });
  const total2 = Object.values(base).reduce((s,v)=>s+v,0);
  if(total2 !== 100){
    const k = Object.keys(base).sort((a,b) => base[b] - base[a])[0];
    base[k] += 100 - total2;
  }

  // 8. 货币类集中度约束：按风险偏好设置上限
  const moneyCap = {conservative:50, moderate:35, balanced:20, aggressive:10}[riskProfile] || 50;
  if((base.money||0) > moneyCap){
    const excess = base.money - moneyCap;
    base.money = moneyCap;
    base.bond = (base.bond||0) + excess;
  }

  return base;
}

// 在每个类别中选出最优基金（相关性去重 + 核心-卫星架构）
function selectFunds(cat, catData, riskProfile, pct, totalAmt){
  // 风险等级过滤（带回退机制）
  let pool = catData.topFunds.filter(f=>{
    if(riskProfile==='conservative') return ['R1','R2','R3'].includes(f.risk);
    if(riskProfile==='moderate')     return ['R1','R2','R3','R4'].includes(f.risk);
    return true;
  });
  // 回退机制：保守型用户若选不出基金，放宽到R4
  if(!pool.length && riskProfile==='conservative'){
    pool = catData.topFunds.filter(f=>['R1','R2','R3','R4'].includes(f.risk));
  }
  if(!pool.length) return [];

  // 风险偏好感知排名：不同偏好对同一基金的评价侧重不同
  // 保守型：重稳定性和低回撤（高maxDD扣分）
  // 进取型：重收益动量，但不奖励高回撤（V2 回测证实旧版 maxDD>25 奖励让进取档回撤翻倍到 9.9%）
  const riskAdjust = {
    conservative: f => f.composite - (f.maxDD||0) * 0.3 + Math.min(f.mgrYears||0, 10) * 0.5,
    moderate:     f => f.composite,
    balanced:     f => f.composite + (f.r1||0) * 0.1,
    aggressive:   f => f.composite + (f.r1||0) * 0.15,  // r1 系数 0.15（在 0.1 和原 0.2 之间折中）
  };
  const adjustFn = riskAdjust[riskProfile] || riskAdjust.moderate;
  // 动量反转修正：超涨基金（>同类均值+1σ）降权，超跌基金（<均值-1σ）升权
  // 基于A股均值回归特性，避免追高买入近期涨幅过大的基金
  pool = pool.map(f => {
    let score = adjustFn(f);
    const bench = _catBench[f.cat];
    if(bench && bench.stdR1 > 0){
      const z = ((f.r1||0) - bench.avgR1) / bench.stdR1;
      if(z > 1)  score -= Math.min(8, (z - 1) * 4);  // 超涨：最多扣8分
      if(z < -1 && (f.r3||0) > 0) score += Math.min(5, (-z - 1) * 2.5); // 超跌加分：仅限r3>0（长期向上的回调），排除双负基金
    }
    return {...f, adjustedScore: score};
  }).sort((a,b) => b.adjustedScore - a.adjustedScore);

  // 相关性去重：同一基金经理最多选1只 + 标签去重（自适应）
  const usedManagers = new Set();
  const deduped = [];
  // 预检标签多样性：如果类别内标签过于同质化，降低标签去重力度
  const uniqueTagSets = new Set(pool.map(f => JSON.stringify((f.tags||[]).sort())));
  const tagDiversity = uniqueTagSets.size; // 有几种不同的标签组合
  // 标签组合 <= 2种时视为同质化（如 active 只有"主动权益均衡"和"科技成长行业"）
  const skipTagDedup = tagDiversity <= 2;

  pool.forEach(f => {
    if(usedManagers.has(f.manager) && deduped.length > 0) return;
    // 标签重叠检查
    if(!skipTagDedup){
      const fTags = new Set(f.tags||[]);
      let tooSimilar = false;
      deduped.forEach(sel => {
        const overlap = (sel.tags||[]).filter(t => fTags.has(t)).length;
        if(fTags.size > 0 && overlap / fTags.size > 0.5) tooSimilar = true;
      });
      if(tooSimilar && deduped.length > 0) return;
    }
    usedManagers.add(f.manager);
    deduped.push(f);
  });

  // 选几只：≥25%选3只，≥15%选2只，其他1只（V2 3.3-test2 更分散化）
  const pickCount = pct >= 25 && deduped.length >= 3 ? 3 : pct >= 15 && deduped.length >= 2 ? 2 : 1;
  let picks = deduped.slice(0, pickCount);

  // 暂停申购检查：若基金暂停，替换为同类别替代基金
  picks = picks.map(f => {
    const availableCode = checkFundAvailability(f.code);
    if(availableCode !== f.code){
      const alternative = CURATED_FUNDS.find(af => af.code === availableCode);
      if(alternative){
        return {...alternative, composite: f.composite, adjustedScore: f.adjustedScore};
      }
    }
    return f;
  });

  // 核心-卫星分配：按评分差距自适应（评分接近→趋向均分，差距大→集中核心仓）
  // 集中度控制：单只基金不超过30%
  const maxSingleFundPct = 30;
  let perPick;
  if(pickCount === 3){
    const spread = picks[0].composite - picks[2].composite;
    let coreRatio = Math.min(0.60, Math.max(0.40, 0.40 + spread * 0.004));
    // 确保核心仓不超过30%
    if(pct * coreRatio > maxSingleFundPct) coreRatio = maxSingleFundPct / pct;
    const spread12 = picks[0].composite - picks[1].composite;
    const satRatio2 = (1 - coreRatio) * (spread12 < 5 ? 0.5 : 0.6);
    const satRatio3 = 1 - coreRatio - satRatio2;
    perPick = [Math.round(pct*coreRatio), Math.round(pct*satRatio2), pct - Math.round(pct*coreRatio) - Math.round(pct*satRatio2)];
  } else if(pickCount === 2){
    const spread = picks[0].composite - picks[1].composite;
    let coreRatio = Math.min(0.80, Math.max(0.55, 0.55 + spread * 0.005));
    // 确保核心仓不超过30%
    if(pct * coreRatio > maxSingleFundPct) coreRatio = maxSingleFundPct / pct;
    perPick = [Math.round(pct*coreRatio), pct - Math.round(pct*coreRatio)];
  } else {
    // 单只基金时，不做上限截断（30%上限在类别间已由computeWeights控制）
    // 截断会导致权重凭空消失（如 pct=40 截断到30，10%无去处）
    perPick = [pct];
  }

  return picks.map((f,i)=>({
    ...f,
    pct: perPick[i],
    amt: Math.round(totalAmt * perPick[i] / 100),
    role: i===0 ? '核心仓' : '卫星仓',
    method: f.cat==='money'?'立即买入': f.cat==='bond'?'立即买入': f.cat==='qdii'?'分批买入':i===0?'分批买入':'一次性买入',
    methodClass: f.cat==='money'||f.cat==='bond'?'method-now': i===0?'method-dca':'method-hold',
  }));
}

// 基于调仓建议生成分步执行步骤（确保与调仓完全一致）
function buildStepsFromRebalPlan(rebalPlan, riskProfile, horizon){
  const steps = [];

  // 无持仓时的简单模式（rebalPlan 为 null）
  if(!rebalPlan){
    steps.push({
      title:'💡 暂无持仓，请按配置方案直接买入',
      desc:'在支付宝中搜索上方推荐的基金代码逐一购买即可。权益类建议分2-3次买入，间隔1-2周。'
    });
    steps.push({
      title:'📅 每半年检视并再平衡',
      desc:'每半年定期检查各基金表现，若某类资产偏离目标权重超过15%（相对偏离），需调整。'
    });
    return steps;
  }

  const {actions, summary} = rebalPlan;

  // 1. 卖出/减仓（先卖后买，资金释放）
  const sellActions = actions.filter(a => a.action === 'sell');
  const reduceActions = actions.filter(a => a.action === 'reduce' || a.action === 'reduce_gentle');
  if(sellActions.length || reduceActions.length){
    const totalRelease = summary.sellAmt + summary.reduceAmt;
    const sellDesc = sellActions.map(a => `「${a.name}」(${a.code}) 赎回 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`);
    const reduceDesc = reduceActions.map(a => `「${a.name}」(${a.code}) 减仓 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`);
    const allDesc = [...sellDesc, ...reduceDesc];
    steps.push({
      title:`💰 赎回/减仓 ${allDesc.length} 只基金，释放 ¥${totalRelease.toLocaleString('zh-CN',{maximumFractionDigits:0})}`,
      desc:`${allDesc.join('；')}。<br>⏰ 赎回资金T+1~T+3到账（QDII可能需要T+7），到账后再执行买入操作。赎回费：持有<7天=1.5%，7天~1年≈0.5%，>2年=0%。`
    });
  }

  // 2. 继续持有
  const holdActions = actions.filter(a => a.action === 'hold');
  if(holdActions.length){
    steps.push({
      title:`✅ 继续持有 ${holdActions.length} 只基金`,
      desc:`${holdActions.map(a => `「${a.name}」(¥${a.currentAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})})`).join('、')}。仓位合适，保持现有配置即可。`
    });
  }

  // 3. 加仓已有基金
  const addActions = actions.filter(a => a.action === 'buy_more');
  if(addActions.length){
    const addTotal = addActions.reduce((s,a) => s + a.actionAmt, 0);
    steps.push({
      title:`📈 加仓 ${addActions.length} 只已有基金 ¥${addTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}`,
      desc:`${addActions.map(a => `「${a.name}」(${a.code}) 加仓 ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`).join('；')}。在支付宝搜索基金代码购买。`
    });
  }

  // 4. 新建仓
  const buyActions = actions.filter(a => a.action === 'buy');
  if(buyActions.length){
    const buyTotal = buyActions.reduce((s,a) => s + a.actionAmt, 0);
    const bondMoney = buyActions.filter(a => ['bond','money'].includes(a.cat));
    const equity = buyActions.filter(a => ['active','index','qdii'].includes(a.cat));
    let desc = '';
    if(bondMoney.length){
      desc += `稳健底仓：${bondMoney.map(a => `「${a.name}」(${a.code}, ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})})`).join('、')}，可一次性买入。`;
    }
    if(equity.length){
      if(desc) desc += '<br>';
      desc += `权益基金：${equity.map(a => `「${a.name}」(${a.code}, ¥${a.actionAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})})`).join('、')}，建议分2-3次买入，间隔1-2周。`;
      desc += '<br>注意：QDII基金可能有单日限购额度，大额需分多日买入。';
    }
    steps.push({
      title:`🛒 新建仓 ${buyActions.length} 只基金 ¥${buyTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}`,
      desc
    });
  }

  // 5. 卫星仓观察
  const satActions = actions.filter(a => a.action === 'satellite');
  if(satActions.length){
    steps.push({
      title:`👀 ${satActions.length} 只非核心仓继续观察`,
      desc:`${satActions.map(a => `「${a.name}」(¥${a.currentAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})})`).join('、')}。这些基金不在核心推荐中但表现尚可，可作为卫星仓继续持有。`
    });
  }

  // 6. 再平衡+止损
  steps.push({
    title:'📅 每半年检视并再平衡',
    desc:'每半年定期检查各基金表现，若某类资产偏离目标权重超过15%（相对偏离），需卖出高配部分、补仓低配部分。'
  });
  steps.push({
    title:'🛡️ 设置止损/止盈纪律',
    desc:`建议：单只基金亏损超过${riskProfile==='conservative'?15:riskProfile==='moderate'?20:25}%时降仓；组合整体收益达到${riskProfile==='conservative'?20:riskProfile==='moderate'?30:50}%时考虑部分止盈。`
  });

  return steps;
}

// 旧版 buildSteps 保留兼容（无持仓时回退使用）
function buildSteps(weights, picks, totalAmt, monthly, riskProfile, horizon){
  const allPicks = Object.values(picks).flat();
  const newFunds = allPicks.filter(f=>!f.isExisting);
  const immediateFunds = newFunds.filter(f=>['money','bond'].includes(f.cat));
  const equityFunds = newFunds.filter(f=>['active','index','qdii'].includes(f.cat));
  const steps = [];
  if(immediateFunds.length){
    steps.push({title:`💰 买入稳健底仓 ¥${immediateFunds.reduce((s,f)=>s+f.amt,0).toLocaleString()}`, desc:`${immediateFunds.map(f=>`「${f.name}」(${f.code})`).join('、')}。`});
  }
  if(equityFunds.length){
    steps.push({title:`📊 分批买入权益基金 ¥${equityFunds.reduce((s,f)=>s+f.amt,0).toLocaleString()}`, desc:`${equityFunds.map(f=>`「${f.name}」(${f.code}, ¥${f.amt.toLocaleString()})`).join('、')}。建议分2-3次买入。`});
  }
  steps.push({title:'📅 每半年检视并再平衡', desc:'定期检查，偏离目标权重超过15%时调整。'});
  return steps;
}

// 主函数
async function generateSmartPortfolio(){
  // 校验：金额、风险偏好、投资期限
  const spAmountEl = document.getElementById('sp-amount');
  const amountRaw = spAmountEl.value.trim();
  const amountVal = parseFloat(amountRaw)||0;
  const riskVal = document.getElementById('sp-risk').value;
  const horizonVal = document.getElementById('sp-horizon').value;
  const riskSel = document.getElementById('risk-selector');
  const horizonSel = document.getElementById('horizon-selector');

  let missing = [];
  // 金额校验：非空、非负、非特殊符号、合理范围
  if(!amountRaw || amountVal <= 0 || !isFinite(amountVal)){
    missing.push('投入金额');
    spAmountEl.style.borderColor='var(--danger)';
    setTimeout(()=>{spAmountEl.style.borderColor='var(--border)';},3000);
  } else if(amountVal > 100000000){
    showToast('金额超出合理范围（上限1亿）','error');
    spAmountEl.focus();
    return;
  }
  if(!riskVal){ missing.push('风险偏好'); riskSel.style.outline='2px solid var(--danger)'; riskSel.style.borderRadius='8px'; }
  else { riskSel.style.outline=''; }
  if(!horizonVal){ missing.push('投资期限'); horizonSel.style.outline='2px solid var(--danger)'; horizonSel.style.borderRadius='8px'; }
  else { horizonSel.style.outline=''; }
  if(missing.length){
    showToast(`请先${missing.length===1?'填写':'完成'}${missing.join('、')}`, 'error');
    if(missing.includes('投入金额')) spAmountEl.focus();
    autoFadeErrors();
    return;
  }

  // 待确认持仓检查：在进入数据加载流程前立即拦截
  const pendingCount = existingHoldings.filter(h => h.status === 'pending').length;
  if(pendingCount > 0){
    showToast(`您有 ${pendingCount} 笔基金待确认份额，请先在「我的持仓」中完成确认后再生成方案`, 'error', 4000);
    return;
  }

  const btn=document.getElementById('gen-btn');
  btn.disabled=true; btn.innerHTML='<span class="loading-dot"></span> 准备数据中…';
  document.getElementById('gen-status').textContent='';

  // 显示结果区 + 内联加载卡片
  document.getElementById('portfolio-result').style.display='block';
  const loadCard=document.getElementById('gen-loading-card');
  const planSummary=document.getElementById('plan-summary');
  const resultSections=document.querySelectorAll('#portfolio-result > *:not(#gen-loading-card)');
  resultSections.forEach(el=>{el.style.display='none';});
  loadCard.style.display='';

  // 滚动到加载卡片
  setTimeout(()=>loadCard.scrollIntoView({behavior:'smooth',block:'center'}),100);

  // 自动更新基金详情数据（如果需要）
  try {
    btn.innerHTML='<span class="loading-dot"></span> 更新基金数据中…';
    await refreshFundDetails(false);
    await scanMarketFunds(false);
  } catch(e){
    console.warn('[AutoUpdate] 基金数据更新失败，使用缓存数据:', e);
  }

  btn.innerHTML='<span class="loading-dot"></span> 加载净值数据中…';

  // 如果已有足够净值缓存（>10只），显示策略步骤动画后生成
  if(Object.keys(navCache).length >= 10){
    const bar=document.getElementById('gen-loading-bar');
    const countEl=document.getElementById('gen-loading-count');
    const textEl=document.getElementById('gen-loading-text');
    const iconEl=document.getElementById('gen-loading-icon');
    const stepsEl=document.getElementById('gen-steps');
    const cached=Object.keys(navCache).length;
    countEl.textContent=`已缓存 ${cached}/${CURATED_FUNDS.length} 只基金实时数据`;

    const steps=[
      {icon:'📊',text:'5维正交模型评分（Calmar+一致性+任期+规模+费率）',pct:15},
      {icon:'📡',text:'分析市场动量信号，推断经济周期阶段',pct:30},
      {icon:'⚖️',text:'Risk Parity风险平价基础配置',pct:45},
      {icon:'🎚️',text:'风险偏好倾斜 + 期限约束叠加',pct:60},
      {icon:'🔍',text:'智能选基（去重+核心卫星分配）',pct:75},
      {icon:'🧪',text:'6大历史危机压力测试',pct:88},
      {icon:'✅',text:'生成专属投资方案',pct:100}
    ];

    stepsEl.style.display='block';
    stepsEl.innerHTML='';

    let i=0;
    function showStep(){
      if(i>=steps.length){ return; }
      const s=steps[i];
      iconEl.textContent=s.icon;
      textEl.textContent=s.text;
      bar.style.width=s.pct+'%';
      const stepDiv=document.createElement('div');
      stepDiv.style.cssText='font-size:12px;line-height:1.8;color:var(--muted);opacity:0;transition:opacity .3s';
      stepDiv.innerHTML=`<span style="color:var(--success)">✓</span> ${s.text}`;
      stepsEl.appendChild(stepDiv);
      requestAnimationFrame(()=>stepDiv.style.opacity='1');
      i++;
      if(i<steps.length){
        setTimeout(showStep, 350);
      } else {
        setTimeout(()=>{
          loadCard.style.display='none';
          stepsEl.style.display='none';
          resultSections.forEach(el=>{el.style.display='';});
          _finishGenerate(btn, true);
        },500);
      }
    }
    showStep();
    return;
  }

  // 否则，先拉取净值，带进度显示
  const bar=document.getElementById('gen-loading-bar');
  const countEl=document.getElementById('gen-loading-count');
  const textEl=document.getElementById('gen-loading-text');
  const total=CURATED_FUNDS.length;
  let done=0;

  bar.style.width='0%';
  countEl.textContent=`0 / ${total}`;
  textEl.textContent='正在获取实时净值数据…';

  CURATED_FUNDS.forEach(f=>fetchNav(f.code, data=>{
    updateNavCard(f.code,data);
    done++;
    const pct=Math.round(done/total*100);
    bar.style.width=pct+'%';
    countEl.textContent=`${done} / ${total}`;
    if(done >= Math.floor(total*0.3)){
      textEl.textContent='正在分析市场行情…';
    }
    if(done >= Math.floor(total*0.7)){
      textEl.textContent='正在生成专属方案…';
    }

    if(done===total){
      const now=new Date();
      const navTimeEl = document.getElementById('nav-update-time');
      if(navTimeEl) navTimeEl.textContent=`净值更新于 ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;

      // 数据加载完成，展示策略执行步骤
      const iconEl=document.getElementById('gen-loading-icon');
      const stepsEl=document.getElementById('gen-steps');
      countEl.textContent='数据加载完成，开始策略计算';
      stepsEl.style.display='block';
      stepsEl.innerHTML='';

      const algoSteps=[
        {icon:'📊',text:'5维正交模型评分（Calmar+一致性+任期+规模+费率）'},
        {icon:'📡',text:'分析市场动量信号，推断经济周期阶段'},
        {icon:'⚖️',text:'Risk Parity风险平价基础配置'},
        {icon:'🎚️',text:'风险偏好倾斜 + 期限约束叠加'},
        {icon:'🔍',text:'智能选基（去重+核心卫星分配）'},
        {icon:'🧪',text:'6大历史危机压力测试'},
        {icon:'✅',text:'生成专属投资方案'}
      ];

      let si=0;
      function showAlgoStep(){
        if(si>=algoSteps.length) return;
        const s=algoSteps[si];
        iconEl.textContent=s.icon;
        textEl.textContent=s.text;
        bar.style.width=(60+si*40/algoSteps.length)+'%';
        const stepDiv=document.createElement('div');
        stepDiv.style.cssText='font-size:12px;line-height:1.8;color:var(--muted);opacity:0;transition:opacity .3s';
        stepDiv.innerHTML=`<span style="color:var(--success)">✓</span> ${s.text}`;
        stepsEl.appendChild(stepDiv);
        requestAnimationFrame(()=>stepDiv.style.opacity='1');
        si++;
        if(si<algoSteps.length){
          setTimeout(showAlgoStep, 350);
        } else {
          bar.style.width='100%';
          setTimeout(()=>{
            loadCard.style.display='none';
            stepsEl.style.display='none';
            resultSections.forEach(el=>{el.style.display='';});
            _finishGenerate(btn, true);
            renderDcaRanking();
          },500);
        }
      }
      showAlgoStep();
    }
  }));
}

function _finishGenerate(btn, shouldScroll){
  let ok = false;
  try { ok = _doGenerate(shouldScroll); } catch(e){ console.error(e); }
  if(ok){
    _portfolioGenerated = true;
    const hint = document.getElementById('holdings-changed-hint');
    if(hint) hint.classList.remove('show');
  }
  btn.disabled=true;
  btn.innerHTML='✅ 已生成方案';
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';
  const cached=Object.keys(navCache).length;
  document.getElementById('gen-status').textContent=cached>0?`已融合 ${cached} 只基金实时净值`:'';
}

function resetSmartGenButton(){
  const btn = document.getElementById('gen-btn');
  if(btn && btn.disabled){
    btn.disabled = false;
    btn.innerHTML = '🤖 生成我的专属方案';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function _doGenerate(shouldScroll){
  // 精选库未加载时等待后重试（loadCuratedFunds 异步，可能尚未完成）
  if(CURATED_FUNDS.length === 0){
    setTimeout(()=>_doGenerate(shouldScroll), 500);
    return;
  }
  // 数据新鲜度守卫：检测精选库数据是否超过7天未更新
  const staleNotice = document.getElementById('data-stale-notice');
  const isStale = !_curatedTimestamp || (Date.now() - new Date(_curatedTimestamp).getTime()) > 7 * 24 * 60 * 60 * 1000;
  const isEmpty = false;
  if(isEmpty || isStale){
    const msg = isEmpty
      ? '⚠️ <b>精选基金库尚未加载</b>，无法生成方案。请检查网络连接后刷新页面重试。'
      : `⚠️ <b>基金数据已超过7天未更新</b>（最后更新：${_curatedTimestamp ? new Date(_curatedTimestamp).toLocaleDateString('zh-CN') : '未知'}），推荐结果可能不准确。建议先触发 GitHub Actions 更新数据后再生成方案。`;
    if(!staleNotice){
      const notice = document.createElement('div');
      notice.id = 'data-stale-notice';
      notice.className = 'warning-notice';
      notice.style.cssText = 'background:#fff1f0;border-left:4px solid #ff4d4f;padding:10px 14px;border-radius:6px;color:#a8071a;font-weight:500;margin-bottom:12px';
      notice.innerHTML = msg;
      const resultEl = document.getElementById('portfolio-result');
      if(resultEl) resultEl.insertBefore(notice, resultEl.firstChild);
    } else {
      staleNotice.innerHTML = msg;
      staleNotice.style.display = '';
    }
    if(isEmpty) return; // 库为空时直接中止，无法生成方案
  } else {
    if(staleNotice) staleNotice.style.display = 'none';
  }

  const totalAmt  = parseFloat(document.getElementById('sp-amount').value)||0;
  const riskP     = document.getElementById('sp-risk').value;
  const horizon   = parseInt(document.getElementById('sp-horizon').value);
  const monthly   = 0; // 智能方案为一次性配置，定投在独立Tab

  // 1. 行情分析
  const catRanks = analyzeCategoryPerf();

  // 2. 市场动量信号
  const macroClock = inferMomentumPhase(catRanks);
  const mgrWarnings = detectManagerChanges();

  // 3. 渲染行情分析表
  renderMarketAnalysis(catRanks, macroClock, mgrWarnings);

  // 4. 计算权重（叠加动量约束）
  const weights = computeWeights(riskP, horizon, catRanks, macroClock);

  // 4.5 融合已有持仓分析
  const existTotal = existingHoldings.reduce((s,h)=>s+h.value,0);
  const portfolioTotal = existTotal + totalAmt; // 总资产 = 已有 + 新资金
  const hasHoldings = existTotal > 0;

  // 分析已有持仓：按类别分组 + 质量评估（修复问题4：使用最新净值计算市值）
  const holdingsByCat = {}; // { cat: [{code,name,value,score,keep,fundData}] }
  const replaceSuggestions = []; // 建议替换的低分基金
  if(hasHoldings){
    existingHoldings.forEach(h=>{
      const fd = CURATED_FUNDS.find(f=>f.code===h.code);
      const cat = fd ? fd.cat : null;
      if(!cat) return; // 未知基金跳过

      // 使用 h.value 作为当前市值（与 existTotal 计算基准一致，避免二次计算导致不一致）
      const currentValue = h.value || 0;

      const score = scoreF(fd);
      const keep = score >= 60; // 评分≥60为达标（60分及格线，与持仓诊断标准统一）
      if(!holdingsByCat[cat]) holdingsByCat[cat] = [];
      holdingsByCat[cat].push({ code:h.code, name:h.name||fd.name, value:currentValue, score, keep, fundData:fd });
      // 只有评分<60且已确认的持仓才建议替换
      if(!keep && h.status === 'confirmed') replaceSuggestions.push({ code:h.code, name:h.name||fd.name, cat, score, value:currentValue });
    });
  }

  // 计算每个类别的缺口：目标金额 - 已有达标基金金额
  const catGap = {};
  const catKept = {}; // 每个类别保留的已有基金
  let freedFromOverweight = 0; // 超配类别缩减释放的资金
  catRanks.forEach(cd=>{
    const cat = cd.cat;
    const targetAmt = portfolioTotal * (weights[cat]||0) / 100;
    // 所有已持仓基金（不管评分高低）都参与调仓计算
    const allHeldFunds = holdingsByCat[cat]||[];
    const keptFunds = allHeldFunds; // 不再按评分过滤，已持仓基金都纳入目标
    const keptAmt = keptFunds.reduce((s,h)=>s+h.value,0);
    if(keptAmt > targetAmt){
      freedFromOverweight += keptAmt - targetAmt;
      catGap[cat] = 0;
    } else {
      catGap[cat] = targetAmt - keptAmt;
    }
    catKept[cat] = keptFunds;
  });
  const totalGap = Object.values(catGap).reduce((s,v)=>s+v,0);
  const distributableMoney = totalAmt + freedFromOverweight; // 新增资金 + 超配释放资金

  // 5. 选基（融合已有持仓）
  const selectedPicks = {};
  catRanks.forEach(cd=>{
    const w = weights[cd.cat]||0;
    if(w<=0) return;
    const kept = catKept[cd.cat]||[];
    const gap = catGap[cd.cat]||0;
    // 该类别分配的新资金 = 总新资金 × (缺口占比)，确保不超过新资金总额
    const newMoneyForCat = totalGap > 0 ? Math.round(distributableMoney * gap / totalGap) : 0;

    // 已保留基金纳入推荐
    // 若该类别超配，按目标金额缩减 amt；若不足，优先将缺口分配给评分达标的已持仓基金（加仓）
    const catTargetAmt = portfolioTotal * w / 100;
    const keptValueTotal = kept.reduce((s,h) => s + h.value, 0);
    const keptScale = (keptValueTotal > catTargetAmt && catTargetAmt > 0) ? catTargetAmt / keptValueTotal : 1;

    // 缺口优先分配给评分达标的已持仓基金（加仓），按持仓比例分配
    const keepFunds = kept.filter(h => h.keep);
    let remainingGap = gap; // 分配给已持仓后的剩余缺口
    const keptAddMap = {}; // code -> 加仓金额
    if(gap > 0 && keepFunds.length > 0 && newMoneyForCat > 0){
      const keepTotal = keepFunds.reduce((s,h) => s + h.value, 0) || 1;
      keepFunds.forEach(h => {
        const addAmt = Math.round(newMoneyForCat * (h.value / keepTotal));
        keptAddMap[h.code] = addAmt;
        remainingGap -= addAmt;
      });
      remainingGap = Math.max(0, remainingGap);
    }

    const keptPicks = kept.map(h=>{
      const targetAmt = Math.round(h.value * keptScale + (keptAddMap[h.code]||0));
      const diffAmt = targetAmt - h.value;
      const tolPct = ['money','bond'].includes(h.fundData.cat) ? 0.10 : h.fundData.cat === 'index' ? 0.15 : 0.20;
      const tolMin = ['money','bond'].includes(h.fundData.cat) ? 300 : h.fundData.cat === 'index' ? 500 : 800;
      const tol = Math.max(targetAmt * tolPct, tolMin);
      let method, role;
      if(diffAmt > tol){ method='加仓至目标配置'; role='已持有·加仓'; }
      else if(diffAmt < -tol){ method='减仓至目标配置'; role='已持有·减配'; }
      else { method = h.keep ? '继续持有' : '建议逐步替换'; role = h.keep ? '已持有·保留' : '已持有·低分'; }
      return {
        ...h.fundData,
        pct: Math.round(targetAmt / portfolioTotal * 100),
        amt: targetAmt,
        role, method,
        methodClass: 'method-hold',
        isExisting: true,
        newBuyAmt: keptAddMap[h.code] || 0,
      };
    }).filter(p => p.amt >= 100);

    // 新买入的基金（从候选池中选，排除已持有的），仅用剩余缺口
    let newPicks = [];
    if(remainingGap > 0){
      const newPctForCat = Math.round(remainingGap / portfolioTotal * 100);
      if(newPctForCat > 0){
        const poolExcluded = {
          ...cd,
          topFunds: cd.topFunds.filter(f=>!existingHoldings.some(h=>h.code===f.code))
        };
        newPicks = selectFunds(cd.cat, poolExcluded, riskP, newPctForCat, portfolioTotal);
        newPicks.forEach(p=>{ p.isExisting = false; });
      }
    }

    selectedPicks[cd.cat] = [...keptPicks, ...newPicks];

    // 去重：如果同一只基金既在keptPicks又在newPicks中，合并为一个条目
    const merged = {};
    selectedPicks[cd.cat].forEach(p => {
      if(!merged[p.code]){
        merged[p.code] = p;
      } else {
        // 同一只基金出现两次，合并：保留已有持仓，累加新买入金额
        const existing = merged[p.code];
        if(!p.isExisting){
          // p是新买入，existing是已有持仓
          const newBuyAmt = p.amt; // 记录新买入金额
          existing.amt += p.amt;
          existing.pct += p.pct;
          existing.method = '继续持有+加仓';
          existing.role = '已持有·加仓';
          existing.newBuyAmt = newBuyAmt; // 保存新买入金额，用于后续校验
        }
      }
    });
    selectedPicks[cd.cat] = Object.values(merged);
  });

  // 4.9 回收空类别的权重：风险过滤后某些类别可能选不出基金
  // 将空类别的百分比按比例分配给已有基金的类别
  const emptyCats = catRanks.filter(c => !selectedPicks[c.cat] || !selectedPicks[c.cat].length);
  const filledCats = catRanks.filter(c => selectedPicks[c.cat] && selectedPicks[c.cat].length > 0);
  if(emptyCats.length > 0 && filledCats.length > 0){
    const freedPct = emptyCats.reduce((s,c) => s + (weights[c.cat]||0), 0);
    const filledTotal = filledCats.reduce((s,c) => s + (weights[c.cat]||0), 0);
    if(freedPct > 0 && filledTotal > 0){
      filledCats.forEach(c => {
        const share = (weights[c.cat]||0) / filledTotal;
        const extra = Math.round(freedPct * share);
        // 按比例增加已选基金的百分比和金额
        const picks = selectedPicks[c.cat];
        const catTotalPct = picks.reduce((s,p) => s + p.pct, 0);
        if(catTotalPct > 0){
          picks.forEach(p => {
            const ratio = p.pct / catTotalPct;
            p.pct += Math.round(extra * ratio);
            p.amt = Math.round(portfolioTotal * p.pct / 100);
          });
        }
      });
    }
    // 清理空类别
    emptyCats.forEach(c => delete selectedPicks[c.cat]);

    // 回收权重后立即归一化
    const allPicksAfterRecycle = Object.values(selectedPicks).flat();
    allPicksAfterRecycle.forEach(p => {
      p.pct = Math.round(p.amt / portfolioTotal * 100);
    });
    let totalPctAfterRecycle = allPicksAfterRecycle.reduce((s,p) => s + p.pct, 0);
    if(totalPctAfterRecycle !== 100 && allPicksAfterRecycle.length > 0 && totalPctAfterRecycle > 0){
      const scale = 100 / totalPctAfterRecycle;
      allPicksAfterRecycle.forEach(p => {
        p.pct = Math.round(p.pct * scale);
        p.amt = Math.round(portfolioTotal * p.pct / 100);
      });
      totalPctAfterRecycle = allPicksAfterRecycle.reduce((s,p) => s + p.pct, 0);
      if(totalPctAfterRecycle !== 100){
        const diff = 100 - totalPctAfterRecycle;
        const maxPick = [...allPicksAfterRecycle].sort((a,b) => b.pct - a.pct)[0];
        maxPick.pct += diff;
        maxPick.amt = Math.round(portfolioTotal * maxPick.pct / 100);
      }
    }
  }

  // 修正舍入误差：确保总百分比=100%
  const allPicksRaw = Object.values(selectedPicks).flat();
  normalizePicksPercentage(allPicksRaw, portfolioTotal);

  // 归一化函数：确保百分比总和为100%，并同步金额
  function normalizePicksPercentage(picks, portfolioTotal){
    if(!picks.length) return;
    picks.forEach(f => f.pct = Math.round(f.amt / portfolioTotal * 100));
    let totalPct = picks.reduce((s, f) => s + f.pct, 0);
    if(totalPct !== 100 && totalPct > 0){
      const scale = 100 / totalPct;
      picks.forEach(f => {
        f.pct = Math.round(f.pct * scale);
        f.amt = Math.round(portfolioTotal * f.pct / 100);
      });
      totalPct = picks.reduce((s, f) => s + f.pct, 0);
      if(totalPct !== 100){
        const diff = 100 - totalPct;
        const maxPick = [...picks].sort((a,b) => b.pct - a.pct)[0];
        maxPick.pct += diff;
        maxPick.amt = Math.round(portfolioTotal * maxPick.pct / 100);
      }
    }
  }

  const allPicks = Object.values(selectedPicks).flat();

  // 过滤掉金额过小的基金（< 100元），避免推荐0元或极小金额的基金
  const filteredPicks = allPicks.filter(f => f.amt >= 100);
  if(filteredPicks.length < allPicks.length){
    // 计算被过滤基金中有多少是新买入的金额
    const removedFunds = allPicks.filter(f => f.amt < 100);
    const removedNewBuyAmt = removedFunds.reduce((s, f) => {
      if(!f.isExisting) return s + f.amt;
      if(f.newBuyAmt) return s + f.newBuyAmt;
      return s;
    }, 0);

    if(filteredPicks.length > 0 && removedNewBuyAmt > 0){
      // 将新买入金额重新分配到接收新资金的基金上
      const newBuyFunds = filteredPicks.filter(f => !f.isExisting || f.newBuyAmt);
      if(newBuyFunds.length > 0){
        const totalPct = newBuyFunds.reduce((s, f) => s + f.pct, 0);
        newBuyFunds.forEach(f => {
          const addAmt = Math.round(removedNewBuyAmt * f.pct / totalPct);
          f.amt += addAmt;
          if(f.newBuyAmt) f.newBuyAmt += addAmt;
        });
      }
    }
    // 更新 selectedPicks
    Object.keys(selectedPicks).forEach(cat => {
      selectedPicks[cat] = selectedPicks[cat].filter(f => f.amt >= 100);
    });

    // 重新计算百分比并归一化
    normalizePicksPercentage(filteredPicks, portfolioTotal);
  }

  const finalPicks = filteredPicks;
  if(!finalPicks.length){
    document.getElementById('plan-summary').innerHTML='<div style="padding:20px;text-align:center;color:var(--muted)">⚠️ 未能生成方案，请检查基金数据是否加载完成后重试。</div>';
    return;
  }

  // 最终百分比归一化：确保所有基金百分比总和为100%
  normalizePicksPercentage(finalPicks, portfolioTotal);

  // 金额校验：确保新买入的总金额等于用户输入的新资金（totalAmt）
  // 包括纯新买入的基金 + 合并后基金的新买入部分（newBuyAmt）
  const newBuyTotal = finalPicks.reduce((s, f) => {
    if(!f.isExisting){
      return s + f.amt; // 纯新买入的基金
    } else if(f.newBuyAmt){
      return s + f.newBuyAmt; // 合并后基金的新买入部分
    }
    return s;
  }, 0);
  const newBuyDiff = totalAmt - newBuyTotal;
  if(Math.abs(newBuyDiff) > 1){
    const candidates = finalPicks.filter(f => !f.isExisting || f.newBuyAmt);
    if(candidates.length > 0){
      if(newBuyDiff > 0){
        // 资金有剩余：加到最大买入基金上
        const maxNewBuy = candidates.sort((a,b)=>{
          const amtA = !a.isExisting ? a.amt : (a.newBuyAmt||0);
          const amtB = !b.isExisting ? b.amt : (b.newBuyAmt||0);
          return amtB - amtA;
        })[0];
        if(!maxNewBuy.isExisting){ maxNewBuy.amt += newBuyDiff; }
        else { maxNewBuy.newBuyAmt += newBuyDiff; maxNewBuy.amt += newBuyDiff; }
        maxNewBuy.pct = Math.round(maxNewBuy.amt / portfolioTotal * 100);
      } else {
        // 资金不足：按比例缩减所有新买入基金，确保没有负数
        const totalNewBuy = candidates.reduce((s,f)=>s+(!f.isExisting?f.amt:(f.newBuyAmt||0)),0);
        if(totalNewBuy > 0){
          const scale = totalAmt / totalNewBuy;
          candidates.forEach(f => {
            if(!f.isExisting){
              f.amt = Math.max(0, Math.round(f.amt * scale));
            } else if(f.newBuyAmt){
              const scaled = Math.max(0, Math.round(f.newBuyAmt * scale));
              f.amt = f.amt - f.newBuyAmt + scaled;
              f.newBuyAmt = scaled;
            }
            f.pct = Math.round(f.amt / portfolioTotal * 100);
          });
        }
      }
    }
  }

  // 金额校验后重新归一化百分比
  normalizePicksPercentage(finalPicks, portfolioTotal);

  // 最终金额校验：确保所有基金金额总和精确等于 portfolioTotal
  const finalAmtSum = finalPicks.reduce((s, f) => s + f.amt, 0);
  if(finalAmtSum !== portfolioTotal && finalPicks.length > 0){
    const diff = portfolioTotal - finalAmtSum;
    const maxPick = [...finalPicks].sort((a,b) => b.amt - a.amt)[0];
    maxPick.amt += diff;
    maxPick.pct = Math.round(maxPick.amt / portfolioTotal * 100);
  }
  // 确保所有基金 pct 与 amt 一致
  finalPicks.forEach(f => { f.pct = Math.round(f.amt / portfolioTotal * 100); });
  // 累积舍入误差校正：分别 Math.round 后总和可能 ≠ 100（渲染时分组求和会露出），
  // 把差额补到 pct 最大的那只基金上，确保总和恰好 100
  const finalPctSum = finalPicks.reduce((s, f) => s + f.pct, 0);
  if(finalPctSum !== 100 && finalPicks.length > 0){
    const pctDiff = 100 - finalPctSum;
    const maxPctPick = [...finalPicks].sort((a,b) => b.pct - a.pct)[0];
    maxPctPick.pct += pctDiff;
  }

  // 重新同步selectedPicks：确保computeRebalancePlan使用的是过滤和调整后的数据
  Object.keys(selectedPicks).forEach(cat => {
    selectedPicks[cat] = finalPicks.filter(f => f.cat === cat);
  });

  // 5. 收益预估（长期均值中枢 + 均值回归 + 统计置信区间）
  // 预期收益 = 类别长期年化均值（r3年化）向长期中枢回归，而非 r1 打折
  // 长期中枢参考值（保守估算：剔除牛市后普通投资者实际获得收益约2-3%，主动基金平均跑输指数）
  const longTermMu = { active:3.5, index:4.0, bond:3, money:2, qdii:4.5 };
  // 均值回归：当前r3年化偏离长期中枢越远，回归力度越大
  const expReturn = finalPicks.reduce((s,f) => {
    const r3Ann = f.r3 > -100 ? (Math.pow(1 + f.r3/100, 1/3) - 1) * 100 : 0;
    const mu = longTermMu[f.cat] || 5;
    // 回归系数：r3Ann 偏离 mu 越远，越向 mu 回归
    // 当 r3Ann == mu 时，预期 = mu；偏离越大，预期越接近 mu
    // 均值回归速度校准（基于学术研究的半衰期估算）
    // 理论依据：资产收益率存在均值回归特性（Mean Reversion），偏离长期均值后会逐渐回归
    // 半衰期（Half-life）：收益率偏离均值后，回归到一半距离所需的时间
    //
    // 回归速度计算公式：revSpeed = 1 - exp(-ln(2) × 观测窗口 / 半衰期)
    // - 权益类（股票/指数/QDII）：半衰期 ~5年 → 3年窗口回归速度 = 1 - exp(-ln(2)×3/5) ≈ 0.35
    // - 债券类：半衰期 ~2年 → 3年窗口回归速度 = 1 - exp(-ln(2)×3/2) ≈ 0.65（实际使用0.6保守估计）
    // - 货币类：波动极小，回归速度设为0.1（主要受政策利率影响，非市场驱动）
    //
    // 参考文献：Poterba & Summers (1988), Fama & French (1988) 关于股票收益均值回归的实证研究
    const revSpeed = { active:0.35, index:0.35, bond:0.6, money:0.1, qdii:0.35 }[f.cat] || 0.35;
    const expected = mu + (r3Ann - mu) * (1 - revSpeed);
    return s + expected * (f.pct/100);
  }, 0);
  // 组合波动率估算（正确的多资产协方差模型）
  // 1. 用 estimateVol() 将每只基金 maxDD 转为年化波动率σ（使用各类别 DD_TO_VOL 系数）
  // 2. 类别内：同类基金相关性高(ρ_intra=0.8)，按 Var = ΣΣ wi·wj·ρij·σi·σj 计算
  // 3. 跨类别：使用 CORR_MATRIX 5×5 相关性矩阵（主动-债券ρ=-0.15，指数-债券ρ=-0.10等）
  const RHO_INTRA = 0.8;
  const catFundsMap = {};
  finalPicks.forEach(f => {
    if(!catFundsMap[f.cat]) catFundsMap[f.cat] = [];
    catFundsMap[f.cat].push(f);
  });

  // 类别内方差 + 各类别加权波动率（用于跨类别协方差）
  const catVariance = {};
  const catWeightedSigma = {};
  Object.keys(catFundsMap).forEach(cat => {
    const funds = catFundsMap[cat];
    let intraVar = 0;
    let wSigma = 0;
    for(let i = 0; i < funds.length; i++){
      const wi = funds[i].pct / 100;
      const si = estimateVol(funds[i]);
      wSigma += wi * si;
      for(let j = 0; j < funds.length; j++){
        const wj = funds[j].pct / 100;
        const sj = estimateVol(funds[j]);
        intraVar += wi * wj * (i === j ? 1.0 : RHO_INTRA) * si * sj;
      }
    }
    catVariance[cat] = intraVar;
    catWeightedSigma[cat] = wSigma;
  });

  // 跨类别协方差：使用 CORR_MATRIX
  // 数学推导：Cov(cat_a, cat_b) = ρ_cross(a,b) × Σ(wi_a·σi_a) × Σ(wj_b·σj_b)
  // 即 ρ_cross × catWeightedSigma[a] × catWeightedSigma[b]
  // 双重循环遍历所有有序对(a,b)和(b,a)，与 Var=ΣΣ wi·wj·ρij·σi·σj 等价，无需÷2
  let portfolioVar = 0;
  const catKeys = Object.keys(catVariance);
  catKeys.forEach(ci => {
    catKeys.forEach(cj => {
      if(ci === cj){
        portfolioVar += catVariance[ci];
      } else {
        const rho = (CORR_MATRIX[ci] && CORR_MATRIX[ci][cj] !== undefined)
          ? CORR_MATRIX[ci][cj] : 0.3;
        portfolioVar += rho * catWeightedSigma[ci] * catWeightedSigma[cj];
      }
    });
  });
  const sigma = Math.sqrt(Math.max(portfolioVar, 0.01));
  // 反推组合等效回撤（加权 DD_TO_VOL）
  const avgDDtoVol = finalPicks.reduce((s,f) => s + (DD_TO_VOL[f.cat]||2.5) * f.pct, 0) / 100;
  const blendedDD = sigma * avgDDtoVol;
  // 正态分布置信区间
  const expReturnP75 = expReturn + 0.67 * sigma; // 乐观情景（75分位）
  const expReturnP25 = expReturn - 0.67 * sigma; // 悲观情景（25分位）
  const expReturnP5  = expReturn - 1.65 * sigma; // 极端下行（5分位）
  // 真实统计区间（不做人为保底，如实展示风险）
  const expReturnLow  = expReturnP25;
  const expReturnHigh = Math.max(expReturnP75, expReturn);
  // 1年预测
  const expAmt1Low  = Math.round(totalAmt*(1+expReturnLow/100));
  const expAmt1High = Math.round(totalAmt*(1+expReturnHigh/100));
  // 3年预测（复利 + 考虑收益自相关的波动率扩展）
  // 权益类存在弱负自相关(ρ≈-0.05，均值回归)，债券类正自相关(ρ≈+0.08，利率趋势)
  // σ_T = σ × √(T × (1 + 2×Σ(1-k/T)×ρ_k))，简化为首阶自相关修正
  const cumReturn3Mid = (Math.pow(1 + expReturn/100, 3) - 1) * 100;
  const equityPctTotal = finalPicks.filter(f=>['active','index','qdii'].includes(f.cat)).reduce((s,f)=>s+f.pct,0)/100;
  const autoCorr1 = equityPctTotal * (-0.05) + (1 - equityPctTotal) * 0.08;
  const acFactor = 1 + 2 * (2/3 * autoCorr1 + 1/3 * autoCorr1 * 0.6);
  const cumSigma3 = sigma * Math.sqrt(3 * Math.max(acFactor, 0.5));
  const cumReturn3Low = cumReturn3Mid - 0.67 * cumSigma3;
  const cumReturn3High = cumReturn3Mid + 0.67 * cumSigma3;
  const expAmt3Low  = Math.round(totalAmt * (1 + Math.max(cumReturn3Low, -50)/100));
  const expAmt3High = Math.round(totalAmt * (1 + cumReturn3High/100));

  // 6. 渲染期望横幅
  document.getElementById('expected-banner').innerHTML=`
    <div class="expected-item"><div class="expected-val">${expReturnLow.toFixed(1)}% ~ ${expReturnHigh.toFixed(1)}%</div><div class="expected-label">预期年化收益区间</div></div>
    <div class="expected-item"><div class="expected-val" style="color:var(--success)">¥${expAmt1Low.toLocaleString()}</div><div class="expected-label">1年后保守预估</div></div>
    <div class="expected-item"><div class="expected-val" style="color:var(--primary)">¥${expAmt1High.toLocaleString()}</div><div class="expected-label">1年后乐观预估</div></div>
    <div class="expected-item"><div class="expected-val" style="color:#722ed1">¥${expAmt3Low.toLocaleString()}~${expAmt3High.toLocaleString()}</div><div class="expected-label">3年后预估区间</div></div>
    <div style="width:100%;font-size:11px;color:var(--muted);margin-top:4px;line-height:1.6">
      ⚠️ <b>收益预估仅供参考，不构成收益承诺。</b>模型局限：①预期收益基于各类别长期年化中枢+均值回归模型，历史不代表未来；②波动率由maxDD按类别系数(DD_TO_VOL)转换，使用5×5相关性矩阵(含股债负相关)计算组合方差；③正态分布假设会低估极端尾部风险；④3年投影考虑了收益自相关修正。实际收益可能大幅偏离上述区间。P5极端情景年化可能达 ${expReturnP5.toFixed(1)}%。
    </div>`;

  // 7. 副标题（修复问题6：明确显示总资产构成）
  const riskNames={conservative:'保守型',moderate:'稳健型',balanced:'平衡型',aggressive:'进取型'};
  const horizonNames={1:'1年',2:'1-3年',5:'3-5年',10:'5年+'};
  const subtitleText = existTotal > 0
    ? `${riskNames[riskP]} · ${horizonNames[horizon]} · 总资产 ¥${portfolioTotal.toLocaleString()}（已有 ¥${existTotal.toLocaleString()} + 新增 ¥${totalAmt.toLocaleString()}）`
    : `${riskNames[riskP]} · ${horizonNames[horizon]} · ¥${totalAmt.toLocaleString()}`;
  document.getElementById('plan-subtitle').textContent = subtitleText;

  // 8+9: 配置方案和饼图的渲染延后到 computeRebalancePlan 之后
  // （computeRebalancePlan 可能因资金平衡校验缩减 pick.amt/pct，需先完成再渲染）

  // 10. 风险计量
  renderRiskMeter(blendedDD, riskP);

  // 10.5 风格暴露分析 + 压力测试
  const styleExposure = analyzeStyleExposure(finalPicks);
  const stressResults = stressTest(finalPicks);
  renderStyleExposure(styleExposure, finalPicks);
  renderStressTest(stressResults, totalAmt);

  // 11. 调仓建议（先于执行步骤生成，以便步骤引用调仓数据）
  // existingHoldings.value 保持与AI方案生成时一致（第1214行），不再重复同步，避免两处existTotal不一致
  const rebalPlan = computeRebalancePlan(selectedPicks, totalAmt);
  // 持久化方案，供持仓诊断模块联动（避免对"建议加仓/持有"的基金发出矛盾黄警）
  try {
    if(rebalPlan && Array.isArray(rebalPlan.actions)){
      const compact = {
        timestamp: Date.now(),
        actions: rebalPlan.actions.map(a => ({code:a.code, action:a.action}))
      };
      localStorage.setItem('lastRebalancePlan', JSON.stringify(compact));
    }
  } catch(e){ console.warn('保存 lastRebalancePlan 失败:', e); }
  // 8. 渲染配置方案（在 computeRebalancePlan 之后，pick.amt 已反映资金平衡校验结果）
  renderAllocGroups(selectedPicks, weights);
  // 9. 饼图
  renderPortfolioPie(selectedPicks);
  renderRebalancePlan(rebalPlan);

  // 12. 执行步骤（基于调仓建议生成，确保与调仓一致）
  const steps = buildStepsFromRebalPlan(rebalPlan, riskP, horizon);
  document.getElementById('step-list').innerHTML=steps.map((s,i)=>
    `<li class="step-item"><div class="step-num">${i+1}</div><div class="step-content"><div class="step-title">${s.title}</div><div class="step-desc">${s.desc}</div></div></li>`
  ).join('');

  // 13.5 低分基金替换建议
  let validReplacements = [];
  if(replaceSuggestions.length > 0){
    const rebalCard = document.getElementById('rebal-card');
    if(rebalCard){
      // 先清除旧的替换建议（避免重复渲染）
      rebalCard.querySelectorAll('.replace-suggestion-block').forEach(el => el.remove());

      // 排除已被选为加仓的基金（加仓和替换不能同时出现）
      const addingCodes = new Set();
      Object.values(selectedPicks).forEach(picks => {
        picks.forEach(p => { if(p.method && p.method.includes('加仓')) addingCodes.add(p.code); });
      });

      validReplacements = replaceSuggestions
        .filter(r => !addingCodes.has(r.code))
        .map(r=>{
          const catFunds = catRanks.find(c=>c.cat===r.cat);
          // 替换目标必须：1) ≥60分（及格线） 2) 比原基金高≥10分（有明显优势）
          const betterFunds = catFunds ? catFunds.topFunds.filter(f => {
            const targetScore = scoreF(f);
            return f.code !== r.code && targetScore >= 60 && targetScore >= r.score + 10;
          }) : [];
          const bestInCat = betterFunds.length > 0 ? betterFunds[0] : null;
          return {r, bestInCat};
        }).filter(item => item.bestInCat !== null);

      if(validReplacements.length > 0){
      const replaceHtml = `<div class="replace-suggestion-block" style="margin-top:14px;padding:12px;background:#fff1f0;border-radius:8px;border-left:3px solid var(--danger)">
        <div style="font-size:13px;font-weight:600;color:#cf1322;margin-bottom:8px">⚠️ 建议替换的低分基金</div>
        ${validReplacements.map(({r, bestInCat})=>{
          return `<div style="font-size:12px;line-height:1.8;color:#595959;margin-bottom:4px">
            <b>${escHtml(r.name)}</b>（评分 ${r.score}，市值 ¥${r.value.toLocaleString()}）→
            建议换入 <b style="color:var(--primary)">${escHtml(bestInCat.name)}</b>（评分 ${scoreF(bestInCat)}）
          </div>`;
        }).join('')}
        <div style="font-size:11px;color:var(--muted);margin-top:6px">注：在支付宝中赎回低分基金（到账约1-3个工作日），到账后买入推荐基金。赎回费：&lt;7天=1.5%，7天-1年≈0.5%，&gt;2年=0%。</div>
        <div style="font-size:11px;color:var(--primary);margin-top:6px">💡 更完整的调仓建议（含定投计划、多维度诊断）请查看「持仓诊断」模块的主动调仓建议。</div>
      </div>`;
      rebalCard.insertAdjacentHTML('beforeend', replaceHtml);
      rebalCard.style.display = '';
      }
    }
  }

  // 14. 策略说明
  const stratEl = document.getElementById('strategy-explanation');
  if(stratEl){
    const weightEntries = catRanks.map(c => `${c.name}: 历史最大跌幅均值≈${c.avgDD.toFixed(1)}% → 风险平价权重 ${(1/Math.max(c.avgDD,1)/(catRanks.reduce((s,x)=>s+1/Math.max(x.avgDD,1),0))*100).toFixed(1)}% → 动量+偏好调整后 ${weights[c.cat]||0}%`).join('<br>');
    const clockDesc = macroClock && macroClock.phase !== 'unknown'
      ? `当前市场动量信号为<b>${macroClock.label}</b>（基于资产相对强弱推断，非宏观经济指标），权益系数×${macroClock.equityMult}，债券系数×${macroClock.bondMult}。`
      : '市场动量信号不明确，采用中性配置。';
    stratEl.innerHTML = `
      <div class="notice" style="padding:6px 10px;border-radius:6px;font-size:11px;margin-bottom:10px;border-left:none">📡 基金收益率、最大回撤、规模、经理任期等核心数据由天天基金网API实时拉取（每24小时自动更新），确保评分和方案基于最新市场数据。</div>
      <b>一、基金评分体系（简化多因子）</b><br>
      去除冗余指标，保留5个正交维度：<br>
      · <b>Calmar Ratio</b>（32%权重）：混合Calmar——短期=(近1年收益−基准)/近3年最大回撤(60%)，长期=(近3年年化收益−基准)/近3年最大回撤(40%)。<b>主动/QDII基金用同类均值作为Alpha基准</b>（避免跨市场比较偏差），指数/债券/货币用无风险利率${RISK_FREE}%<br>
      · <b>收益一致性</b>（24%权重）：1年/3年趋势方向是否一致 + 3年收益强度，衡量收益可持续性<br>
      · <b>任期稳定性</b>（22%权重）：客观指标——基金经理连续任期年限，6档评分：<1年=3分(刚更换，高风险)，1-2年=7分(磨合期)，2-3年=11分(初步稳定)，3-5年=15分(稳定)，5-10年=19分(成熟)，>10年=22分(超稳定)。替代主观的星级评定<br>
      · <b>规模适配性</b>（10%权重）：<b>指数基金</b>规模越大越好：≥50亿9分，≥500亿/≥1000亿均满分10分；<b>主动/QDII基金</b>50-500亿满分10分，&gt;1000亿调仓困难4分，&lt;2亿清盘风险2分<br>
      · <b>费率优势</b>（12%权重）：≤0%满分，≤0.05%满分，≤0.08%得10分，≤0.12%得8分，≤0.15%得5分，&gt;0.15%仅2分。费率是预测长期表现的最可靠指标之一<br>
      · <b>估值调整</b>（±10分，指数基金专属）：基于PE百分位，低估加分，高估减分，与定投评分标准统一<br><br>

      <b>二、市场动量约束（基于资产相对强弱的顶层调整）</b><br>
      · 通过各类资产近1年相对收益推断市场状态，本质为动量/相对强弱信号（非真实宏观经济指标）<br>
      · ${clockDesc}<br>
      · 动量判断作为<b>顶层约束</b>叠加于风险平价之上，先于动量调整执行<br>
      · 滞胀期强制提升货币配置下限至15%<br>
      · 当信号不满足6种经典阶段时，判定为<b>信号模糊期</b>，采用中性配置（权益/债券系数均为1.0），不做极端倾斜<br><br>

      <b>三、资产配置方法（Risk Parity + 动量约束 + 动态倾斜）</b><br>
      执行链路：风险平价基础 → 风险偏好倾斜 → 市场动量约束 → 行情动量微调 → 期限上限 → 短期额外调整<br>
      · <b>基础权重（真正的 Risk Parity）</b>：使用迭代法求解等风险贡献，考虑资产间相关性矩阵（股债负相关ρ=-0.15，股票-指数高相关ρ=0.92等）。通过10次迭代优化，使每个资产的边际风险贡献 MRC = w × (Σw) 趋于相等，而非简单的 1/波动率<br>
      · 动量微调中的<b>类别排名</b>使用独立权重：混合Calmar Ratio(短期60%+长期40%) 50% + 趋势一致性(加权幅度) 25% + 经理任期稳定性 20% + 实时动量 5%，与个基评分权重不同，侧重捕捉类别间相对强弱<br>
      · 期限约束：1年≤30%，1-3年≤60%，3-5年≤75%，5年以上≤85%<br>
      · 短期额外调整：投资期限≤1年时，主动权益再减配5%转入债券，进一步降低短期波动暴露<br>
      当前权重推导：<br>${weightEntries}<br><br>

      <b>三(续)、类别内基金选择（核心-卫星架构）</b><br>
      · 每个类别按评分排序后，去除同经理重复和标签重叠>50%的基金<br>
      · 选择数量：该类别权重≥35%选3只，≥25%选2只，其他选1只<br>
      · 选基排名感知风险偏好：保守型侧重低回撤+高稳定性（maxDD扣分+经理年限加分），进取型侧重收益动量+高弹性（r1加分+高波动加分），同一类别内不同偏好可能推荐不同基金<br>
      · 核心-卫星分配：按评分差距自适应——3只时核心仓40-60%（评分差距越大越集中）+卫星仓分配剩余；2只时核心仓55-80%；1只时100%<br>
      · 核心仓采用分批买入降低择时风险，卫星仓一次性建仓<br><br>

      <b>四、基金经理变更监控（慢变量）</b><br>
      · 任职<1年的基金经理自动标记预警<br>
      · 新任经理的历史业绩不可参考（属于前任经理），评分中给予最低稳定性分<br>
      · ${mgrWarnings.length > 0 ? `当前有 ${mgrWarnings.length} 只基金存在经理变更预警` : '当前精选库无经理变更预警'}<br><br>

      <b>五、收益预估（长期均值中枢 + 均值回归模型）</b><br>
      · 预期收益以各类别长期年化均值为中枢（<b>主动3.5%/指数4%/债券3%/货币2%/QDII 4.5%</b>，保守估算：剔除牛市后普通投资者实际获得收益约2-3%，主动基金平均跑输指数：沪深300过去15年年化约4.5%），而非用近期收益打折<br>
      · 均值回归：当基金r3年化偏离长期中枢越远，预期越向中枢回归（回归速度：权益35%（~5年半衰期）、债券60%（~2年半衰期）、货币10%、QDII 35%）<br>
      · 组合波动率：σ=maxDD/类别DD-Vol系数，类别内ρ=0.8协方差计算，跨类别使用5×5相关性矩阵（主动-债券ρ=-0.15，指数-债券ρ=-0.10）<br>
      · 1年区间：μ ± 0.67σ（P25-P75）<br>
      · 3年区间：(1+μ)³−1 ± 0.67σ√3（复利累计收益 ± 累计波动率）<br><br>

      <b>六、风格/行业暴露控制（新增）</b><br>
      · 每只基金标注风格(大盘/中盘 × 价值/均衡/成长)和主要行业<br>
      · 组合构建后自动检查：单一风格>50%预警，单一行业>40%预警<br>
      · 基金选择时已通过标签去重降低风格集中，此处做最终验证<br><br>

      <b>七、信用/流动性/清盘红线（新增）</b><br>
      · 机构占比>80%：巨额赎回风险预警<br>
      · 连续4季度规模缩水：清盘风险预警<br>
      · 规模<5亿（非货币）：接近清盘红线预警<br>
      · 债基专项：信用等级非AAA且久期>2年，信用下沉预警<br><br>

      <b>八、策略鲁棒性（新增）</b><br>
      · 再平衡规则：半年度检视，阈值触发(偏离>15%相对偏离)<br>
      · 交易成本（支付宝1折费率）：混合型A类申购约0.15%，指数联接A类约0.10-0.12%，QDII A类约0.08%，C类免申购费；赎回费7天-1年约0.5%，1-2年0.25%，2年+免赎回费<br>
      · 压力测试：模拟10种历史情景（2015股灾/2018熊市/2020疫情/2022风格切换/债灾/泡沫/2023利率上行/2024小盘暴跌/全球流动性危机/温和市场基准），每个场景附概率估计，输出概率加权期望损失<br><br>

      <b>九、定投评分体系</b><br>
      定投评分独立于基金评分，专门为「定期定额」场景设计，包含4个维度+估值信号：<br>
      · <b>波动适度性</b>（35%权重）：使用钟形曲线建模，各类别最优回撤不同（权益25%、QDII 20%、债券5%）。波动越接近最优区间且r3正收益越高，得分越高<br>
      · <b>长期趋势</b>（25%权重）：3年累计收益r3，连续函数无分档断层，不重度惩罚短期下跌<br>
      · <b>管理质量</b>（20%权重）：基金经理任期年限(满分12分，按任期×0.8计算，15年以上满分) + 星级评定(满分8分，按(星级-1)×2计算)。注：此处保留星级作为辅助参考，因定投周期长，星级反映同类长期排名<br>
      · <b>近期动量反转修正</b>（20%权重）：基于同类z-score判断超涨/超跌。超涨(>均值+1σ)扣分（均值回归），超跌(<均值-1σ)但长期向上加分（定投摊成本黄金窗口）<br>
      · <b>估值信号</b>（±10分，宽基指数专属）：基于PE百分位，低估加分高估减分<br>
      特殊规则：货币基金波动极小不适合定投(固定10分)；r1和r3双负基金大幅降分但不完全排除（周期性底部仍有定投价值）<br>
      <b>AI定投方案</b>：复用 Risk Parity 动态权重 + 市场动量信号 + selectFunds 多因子选基（与智能推荐模块完全一致），叠加定投评分≥60兜底过滤，确保选出的基金适合定投场景<br><br>

      <b>十、持仓健康诊断</b><br>
      · 动态阈值：以同类基金标准差(σ)为单位判断跑输程度（z-score &lt; -2为显著落后）<br>
      · 持仓集中度：单只基金>40%预警，单一类别>60%预警<br>
      · 结构性下行检测：1年和3年收益双负触发红色预警
    `;
  }

  // 渲染方案摘要卡片
  const riskColors={conservative:'var(--success)',moderate:'var(--primary)',balanced:'var(--warning)',aggressive:'var(--danger)'};
  const keptCount = finalPicks.filter(f=>f.isExisting).length;
  const newCount = finalPicks.length - keptCount;
  const summaryEl=document.getElementById('plan-summary');
  if(summaryEl){
    const holdingNote = hasHoldings
      ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(22,119,255,.08);border-radius:8px;font-size:12px;color:var(--primary);line-height:1.6">
          💼 已融合您的 ${existingHoldings.length} 笔持仓（总市值 ¥${existTotal.toLocaleString()}）：
          保留达标基金 <b>${keptCount}</b> 只，新建仓 <b>${newCount}</b> 只${validReplacements.length>0?`，建议替换 <b>${validReplacements.length}</b> 只低分基金`:''}。
          新资金 ¥${totalAmt.toLocaleString()} 将优先填补配置缺口。
        </div>`
      : '';
    summaryEl.innerHTML=`
      <div style="font-size:14px;font-weight:600;margin-bottom:10px">📋 方案摘要</div>
      <div class="ps-row">
        <div class="ps-item"><div class="ps-val">${finalPicks.length} 只</div><div class="ps-label">${hasHoldings?`保留${keptCount}+新${newCount}`:'推荐基金'}</div></div>
        <div class="ps-item"><div class="ps-val" style="color:${riskColors[riskP]}">${riskNames[riskP]}</div><div class="ps-label">风险类型</div></div>
        <div class="ps-item"><div class="ps-val">${expReturnLow.toFixed(1)}%~${expReturnHigh.toFixed(1)}%</div><div class="ps-label">预期年化区间</div></div>
        <div class="ps-item"><div class="ps-val" style="color:var(--danger)">-${blendedDD.toFixed(1)}%</div><div class="ps-label">组合最大回撤</div></div>
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);line-height:1.6">
        ${finalPicks.map(f=>`${f.isExisting?'<span style="color:var(--primary)">✓</span> ':''}<b>${escHtml(f.name)}</b>(${f.pct}%)`).join(' · ')}
      </div>
      ${holdingNote}`;
  }

  // 显示结果
  document.getElementById('analysis-time').textContent=Object.keys(navCache).length>0?`· 已融合${Object.keys(navCache).length}只基金实时净值`:'· 建议先刷新净值获取实时数据';
  document.getElementById('portfolio-result').style.display='block';
  if(shouldScroll) setTimeout(()=>document.getElementById('plan-summary').scrollIntoView({behavior:'smooth',block:'start'}),100);

  // 记录推荐历史（用于检测最近推荐的基金）
  try {
    const newBuys = finalPicks.filter(f => !f.isExisting);
    if(newBuys.length > 0){
      const history = JSON.parse(localStorage.getItem('recommendHistory') || '[]');
      const now = new Date().toISOString();
      newBuys.forEach(f => {
        history.push({
          date: now,
          code: f.code,
          name: f.name,
          amt: f.amt,
          pct: f.pct,
          action: 'buy'
        });
      });
      // 只保留最近30天的记录
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const filtered = history.filter(h => new Date(h.date).getTime() > cutoff);
      localStorage.setItem('recommendHistory', JSON.stringify(filtered));
    }
  } catch(e){ console.warn('记录推荐历史失败:', e); }

  // 暴露刚生成的方案数据给"保存为我的方案"按钮使用（闭包外访问入口）
  window._lastGeneratedScheme = {
    picks: finalPicks.map(p => ({
      code: p.code, name: p.name, cat: p.cat,
      pct: p.pct, amt: p.amt,
      score: (typeof scoreF === 'function' && CURATED_FUNDS.find(f=>f.code===p.code)) ? scoreF(CURATED_FUNDS.find(f=>f.code===p.code)) : (p.score||0),
      r1: p.r1, r3: p.r3,
      mdd: p.maxDD
    })),
    totalTarget: totalAmt + existTotal,
    weights: weights,
    phase: macroClock ? macroClock.phase : 'unknown',
    phaseLabel: macroClock ? macroClock.label : '',
    risk: riskP,
    horizon: horizon
  };

  // 显示"保存为我的方案"按钮条（生成成功后才出现）
  const schemeActionsEl = document.getElementById('scheme-actions');
  if(schemeActionsEl) schemeActionsEl.style.display = 'flex';

  // 渲染"我的持有方案"折叠块（如果已有保存，显示当前状态；过期则提示）
  if(typeof renderMyHoldingScheme === 'function') renderMyHoldingScheme();

  return true;
}

function renderStyleExposure(exposure, allPicks){
  const sec = document.getElementById('style-exposure-section');
  if(!sec) return;
  const styleEntries = Object.entries(exposure.styles).sort((a,b)=>b[1]-a[1]);
  const indEntries = Object.entries(exposure.industries).sort((a,b)=>b[1]-a[1]);
  const riskHtml = exposure.risks.length > 0
    ? `<div style="margin-top:10px;padding:10px;background:#fff1f0;border-radius:8px;border-left:3px solid #ff4d4f">
        <div style="font-size:13px;font-weight:600;color:#cf1322;margin-bottom:6px">⚠️ 风险预警 (${exposure.risks.length}项)</div>
        ${exposure.risks.map(r=>`<div style="font-size:12px;color:#7c5800;line-height:1.6;margin-bottom:2px">· <b>${escHtml(r.name)}</b>：${escHtml(r.desc)}</div>`).join('')}
      </div>` : '<div style="margin-top:8px;font-size:12px;color:var(--success)">✅ 未发现风格集中、流动性或信用风险预警</div>';
  sec.style.display='block';
  sec.innerHTML=`
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">📊 风格/行业暴露分析</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <div style="flex:1;min-width:140px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">风格暴露</div>
        ${styleEntries.map(([s,pct])=>`<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span style="font-size:12px;width:70px;flex-shrink:0">${escHtml(STYLE_LABELS[s]||s)}</span>
          <div style="flex:1;height:14px;background:#f0f0f0;border-radius:7px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct>50?'#ff4d4f':pct>30?'#faad14':'#1677ff'};border-radius:7px;font-size:10px;color:#fff;text-align:right;padding-right:4px;line-height:14px">${pct}%</div></div>
        </div>`).join('')}
      </div>
      <div style="flex:1;min-width:140px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">行业暴露</div>
        ${indEntries.map(([ind,pct])=>`<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
          <span style="font-size:12px;width:50px;flex-shrink:0">${escHtml(ind)}</span>
          <div style="flex:1;height:14px;background:#f0f0f0;border-radius:7px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${pct>40?'#ff4d4f':pct>25?'#faad14':'#52c41a'};border-radius:7px;font-size:10px;color:#fff;text-align:right;padding-right:4px;line-height:14px">${pct}%</div></div>
        </div>`).join('')}
      </div>
    </div>
    ${riskHtml}`;
}

function renderStressTest(results, stressAmt){
  const sec = document.getElementById('stress-test-section');
  if(!sec) return;
  sec.style.display='block';
  // 计算概率加权期望损失
  const expectedLoss = results.reduce((s,r) => s + (r.prob||0) * Math.min(r.impact, 0), 0);
  sec.innerHTML=`
    <div style="font-size:13px;font-weight:600;margin-bottom:8px">🧪 压力测试（${results.length}种历史情景回测）</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">模拟组合在历史极端行情中的预估表现，帮助理解最坏情况。<b>概率加权期望损失：${expectedLoss.toFixed(2)}%</b>（约¥${Math.abs(Math.round(stressAmt*expectedLoss/100)).toLocaleString()}）</div>
    <div class="table-wrap"><table style="font-size:12px">
      <thead><tr><th>历史情景</th><th>概率</th><th>组合预估涨跌</th><th>预估盈亏</th><th>风险等级</th></tr></thead>
      <tbody>${results.map(r=>{
        const cls = r.impact >= 0 ? 'up' : 'down';
        const risk = r.impact < -20 ? '🔴 极端' : r.impact < -10 ? '🟡 较高' : r.impact < 0 ? '🟢 可控' : '✅ 正收益';
        const amt = Math.round(stressAmt * r.impact / 100);
        return `<tr><td>${r.name}</td><td>${((r.prob||0)*100).toFixed(0)}%</td><td class="${cls}">${r.impact>=0?'+':''}${r.impact.toFixed(1)}%</td><td class="${cls}">${amt>=0?'+':''}¥${Math.abs(amt).toLocaleString()}</td><td>${risk}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <div style="margin-top:8px;padding:8px 12px;background:#f8f9fc;border-radius:6px;font-size:11px;color:var(--muted);line-height:1.6">
      📐 <b>再平衡规则：</b>建议每半年检视，当任一类别偏离目标权重>15%(相对偏离)时触发再平衡。<br>
      💰 <b>交易成本（支付宝1折费率）：</b>混合型A类申购约0.15%，指数联接A类约0.10-0.12%，QDII A类约0.08%，C类/货币基金免申购费。赎回费：&lt;7天=1.5%（惩罚性），7天-1年≈0.5%，1-2年≈0.25%，&gt;2年=0%。QDII基金可能有单日限购（1000-5000元）。每次再平衡综合成本约0.1-0.3%。<br>
      ⏰ <b>再平衡频率：</b>半年度为宜。过频(季度/月度)增加成本且心理负担重，过疏(年度以上)偏离积累过大。阈值触发优于固定日历。
    </div>`;
}

function renderMarketAnalysis(catRanks, macroClock, mgrWarnings){
  const signalHtml = (score,chg) => {
    if(score>8 || chg>0.3) return `<span class="signal-hot">🔥 强势</span>`;
    if(score>4 || chg>0.1) return `<span class="signal-up">↑ 偏强</span>`;
    if(score>1)             return `<span class="signal-stable">✓ 稳定</span>`;
    return `<span class="signal-weak">↓ 偏弱</span>`;
  };
  const rankBadge = (i) => {
    const cls=['rank-1','rank-2','rank-3','',''][i]||'';
    return cls ? `<span class="cat-rank-badge ${cls}">${i+1}</span>` : `<span style="color:var(--muted);font-size:12px;margin-left:3px">${i+1}</span>`;
  };
  const table = document.getElementById('market-analysis-table');
  table.innerHTML=`<thead><tr>
    <th>排名</th><th>资产类别</th><th>近1年均收益</th><th>性价比指数</th>
    <th>今日平均涨跌</th><th>数据来源</th><th>行情信号</th>
  </tr></thead><tbody>${catRanks.map((c,i)=>{
    const chgAvailable = Object.keys(navCache).length>0;
    const chgText = chgAvailable ? (c.avgChg>0?`<span class="up">+${c.avgChg.toFixed(2)}%</span>`:`<span class="${c.avgChg<0?'down':'neutral'}">${c.avgChg.toFixed(2)}%</span>`) : '<span class="neutral">待刷新</span>';
    return `<tr>
      <td>${rankBadge(i)}</td>
      <td><b>${c.name}</b></td>
      <td class="${c.avgR1>=0?'up':'down'}">${c.avgR1>=0?'+':''}${c.avgR1.toFixed(1)}%</td>
      <td>${c.riskAdj.toFixed(2)} <span style="font-size:10px;color:var(--muted)">(收益÷风险)</span></td>
      <td>${chgText}</td>
      <td style="font-size:11px;color:var(--muted)">${chgAvailable?'实时净值':'参考数据'}</td>
      <td>${signalHtml(c.catScore, c.avgChg)}</td>
    </tr>`;
  }).join('')}</tbody>`;

  const top1=catRanks[0], top2=catRanks[1];
  // 手机端卡片化
  renderMarketAnalysisMobile(catRanks);
  const chgNote = Object.keys(navCache).length>0 ? '已融合实时净值数据。' : '建议点击「基金精选推荐」→「刷新净值」后重新生成，以融入当日行情。';

  // 宏观周期 + 经理变更预警
  const clockColors = {recovery:'#237804',overheat:'#d48806',stagflation:'#cf1322',recession:'#0958d9',transition:'#8c8c8c'};
  const clockHtml = macroClock && macroClock.phase !== 'unknown'
    ? `<div style="margin-top:10px;padding:10px 14px;background:linear-gradient(135deg,#f8f9fc,#f0f8ff);border-radius:8px;border-left:3px solid ${clockColors[macroClock.phase]||'#8c8c8c'}">
        <div style="font-size:13px;font-weight:600;color:${clockColors[macroClock.phase]||'#8c8c8c'};margin-bottom:4px">🕐 市场动量信号：${macroClock.label}</div>
        <div style="font-size:12px;color:#595959;line-height:1.6">${macroClock.desc}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">推断依据：权益年均 ${macroClock.equityR1?.toFixed(1)||'--'}% vs 债券年均 ${macroClock.bondR1?.toFixed(1)||'--'}%（基于资产相对强弱，非宏观经济指标）。配置已自动叠加动量约束：权益系数×${macroClock.equityMult}，债券系数×${macroClock.bondMult}。</div>
      </div>` : '';

  const mgrHtml = mgrWarnings && mgrWarnings.length > 0
    ? `<div style="margin-top:10px;padding:10px 14px;background:#fffbe6;border-radius:8px;border-left:3px solid #faad14">
        <div style="font-size:13px;font-weight:600;color:#ad6800;margin-bottom:4px">⚠️ 基金经理变更预警</div>
        ${mgrWarnings.map(w => `<div style="font-size:12px;color:#7c5800;line-height:1.6;margin-bottom:2px">· <b>${w.name}</b>(${w.code})：${w.desc}</div>`).join('')}
      </div>` : '';

  document.getElementById('market-summary').innerHTML=`
    📊 <b>行情解读：</b>当前 <b>${top1.name}</b> 综合表现最强（近1年均收益 <b class="up">+${top1.avgR1.toFixed(1)}%</b>，性价比指数 <b>${top1.riskAdj.toFixed(2)}</b>），
    <b>${top2.name}</b> 紧随其后。本次配置方案已根据以上排名对强势类别适当加仓。${chgNote}
    ${clockHtml}${mgrHtml}`;
}

function renderAllocGroups(selectedPicks, weights){
  const groupDefs = [
    { title:'🏦 基础防御仓（低风险底仓）', cats:['money','bond'], color:'#52c41a' },
    { title:'📈 核心权益仓（A股市场）',     cats:['index','active'], color:'#1677ff' },
    { title:'🌍 全球分散仓（海外配置）',    cats:['qdii'], color:'#722ed1' },
  ];
  const methodLabel = m => {
    if(m.includes('立即')||m.includes('一次性')) return `<span class="method-badge method-now">${m}</span>`;
    if(m.includes('定投')) return `<span class="method-badge method-dca">${m}</span>`;
    return `<span class="method-badge method-hold">${m}</span>`;
  };
  let html='';
  groupDefs.forEach(g=>{
    const picks = g.cats.flatMap(cat=>selectedPicks[cat]||[]).filter(f=>f.amt > 0);
    if(!picks.length) return;
    const groupPct = Math.round(picks.reduce((s,f)=>s+f.pct,0));
    const groupAmt = Math.round(picks.reduce((s,f)=>s+f.amt,0));
    const targetGroupPct = Math.round(g.cats.reduce((s,cat)=>s+(weights[cat]||0),0));
    const targetNote = targetGroupPct !== groupPct
      ? `<span style="font-size:11px;color:var(--muted);margin-left:6px">目标${targetGroupPct}%</span>` : '';
    html+=`<div class="alloc-group">
      <div class="alloc-group-head">
        <span>${g.title}</span>
        <span style="color:${g.color};font-size:14px"><b>${groupPct}%</b> · ¥${groupAmt.toLocaleString()}${targetNote}</span>
      </div>
      <div class="alloc-group-body">${picks.map(f=>{
        const nav=navCache[f.code];
        const chgVal=nav?parseFloat(nav.gszzl)||0:0;
        const todayStr=nav&&nav.gszzl?`<span style="margin-left:6px;font-size:11px;color:${chgVal>=0?'var(--danger)':'var(--success)'}">今日 ${chgVal>=0?'+':''}${chgVal.toFixed(2)}%</span>`:'';
        const shareClass = f.name.includes('A') ? 'A类' : f.name.includes('C') ? 'C类' : '';
        const shareClassHtml = shareClass ? `<span style="font-size:10px;padding:1px 4px;border-radius:3px;background:#e6f7ff;color:#0958d9">${shareClass}</span> ` : '';
        const riskBadge = `<span style="font-size:10px;padding:1px 4px;border-radius:3px;background:${f.risk>='R4'?'#fff1f0':f.risk>='R3'?'#fffbe6':'#f6ffed'};color:${f.risk>='R4'?'#cf1322':f.risk>='R3'?'#ad6800':'#389e0d'}">${f.risk||'R3'}</span>`;
        const navDisplay = nav&&nav.gsz ? ` · 净值${nav.gsz}` : '';
        const feeHtml = f.fee ? `<div style="font-size:10px;color:var(--muted)">费率≈${f.fee}%/年${f.name.includes('C')?'（C类免申购费）':''}</div>` : '';
        return `<div class="alloc-item">
          <div style="width:36px;height:36px;border-radius:8px;background:${g.color}22;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <span style="font-size:16px">${f.cat==='money'?'🏦':f.cat==='bond'?'📑':f.cat==='qdii'?'🌍':f.cat==='index'?'📊':'🎯'}</span>
          </div>
          <div class="alloc-item-name">
            <div class="alloc-item-fund">${f.name} ${todayStr}</div>
            <div class="alloc-item-meta">${shareClassHtml}${riskBadge} 代码 ${f.code} · ${f.type} · ${f.manager} · 近1年 <span class="${f.r1>=0?'up':'down'}">${f.r1>=0?'+':''}${f.r1}%</span>${navDisplay}</div>
            ${feeHtml}
          </div>
          <div class="alloc-item-pct" style="color:${g.color}">${f.pct}%</div>
          <div class="alloc-item-amt">¥${Math.round(f.amt).toLocaleString()}</div>
          <div class="alloc-item-method">${methodLabel(f.method)}</div>
        </div>`;
      }).join('')}</div>
    </div>`;
  });
  document.getElementById('alloc-groups').innerHTML=html;
}

function renderPortfolioPie(selectedPicks){
  const labels=[], data=[], colors=[];
  Object.entries(selectedPicks).forEach(([cat,picks])=>{
    picks.forEach(f=>{
      labels.push(f.name.length>8?f.name.slice(0,8)+'…':f.name);
      data.push(f.pct); colors.push(CAT_COLORS[cat]||'#999');
    });
  });
  if(portfolioPieInst) { try{portfolioPieInst.destroy();}catch(e){} portfolioPieInst=null; }
  portfolioPieInst = new Chart(document.getElementById('portfolioPie'),{
    type:'doughnut',
    data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:2,borderColor:'#fff'}]},
    options:{plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}},cutout:'55%',responsive:true,maintainAspectRatio:true}
  });
}

function renderRiskMeter(blendedDD, riskP){
  const maxDD = {conservative:10, moderate:20, balanced:30, aggressive:45}[riskP];
  const pct = Math.min(blendedDD/maxDD*100,100);
  const zone = pct<40?'安全':pct<70?'合理':'注意';
  const col = pct<40?'#52c41a':pct<70?'#faad14':'#ff4d4f';
  const blocks = 10;
  document.getElementById('risk-meter-bar').innerHTML = Array.from({length:blocks},(_,i)=>{
    const filled = i<Math.round(pct/10);
    return `<div class="risk-block" style="background:${filled?col:'#f0f0f0'}"></div>`;
  }).join('');
  document.getElementById('risk-meter-desc').textContent=`组合加权历史最大跌幅约 ${blendedDD.toFixed(1)}%（您的风险容忍上限 ${maxDD}%），风险占用 ${pct.toFixed(0)}%，处于${zone}区间。`;
}

// ═══════════════ 我的持有方案（一键保存 AI 智能配置方案）═══════════════
// 数据流：_doGenerate → window._lastGeneratedScheme → saveMyHoldingScheme → localStorage
//        localStorage → loadMyHoldingScheme → signals.js 的行动决策层读取
//        覆盖保存时 code 集变化 → 清空 _actionHistory（避免历史计数污染新方案）
const MY_SCHEME_KEY = 'myHoldingScheme';
const ACTION_HISTORY_KEY = '_actionHistory';

function loadMyHoldingScheme(){
  try {
    const raw = localStorage.getItem(MY_SCHEME_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  } catch(e){
    console.warn('[我的持有方案] 读取失败，数据可能损坏:', e);
    try { localStorage.removeItem(MY_SCHEME_KEY); } catch(_){}
    return null;
  }
}

function saveMyHoldingScheme(){
  const gen = window._lastGeneratedScheme;
  if(!gen || !gen.picks || !gen.picks.length){
    if(typeof showToast === 'function') showToast('请先生成方案后再保存', 'error');
    return;
  }
  const prev = loadMyHoldingScheme();
  const scheme = {
    savedAt: Date.now(),
    savedAtDate: new Date().toISOString().slice(0,10),
    phase: gen.phase,
    phaseLabel: gen.phaseLabel,
    targetTotal: gen.totalTarget,
    risk: gen.risk,
    horizon: gen.horizon,
    picks: gen.picks,
    weights: gen.weights
  };

  // 覆盖保存：如果 code 集合变化，清空 actionHistory（冷静期从零开始）
  if(prev){
    const prevCodes = new Set((prev.picks||[]).map(p=>p.code));
    const newCodes = new Set(scheme.picks.map(p=>p.code));
    const sameSet = prevCodes.size === newCodes.size && [...prevCodes].every(c=>newCodes.has(c));
    if(!sameSet){
      try { localStorage.removeItem(ACTION_HISTORY_KEY); } catch(_){}
    }
  }

  try {
    localStorage.setItem(MY_SCHEME_KEY, JSON.stringify(scheme));
    if(typeof showToast === 'function') showToast(prev ? '方案已替换保存' : '方案已保存', 'success');
    renderMyHoldingScheme();
    // 若当前在诊断 tab 或页面已初始化，刷新行动决策区块
    if(typeof renderActionDecisions === 'function'){
      try { renderActionDecisions(); } catch(e){ console.warn('刷新行动决策失败:', e); }
    }
  } catch(e){
    console.error('[我的持有方案] 保存失败:', e);
    if(typeof showToast === 'function') showToast('保存失败：存储空间不足', 'error');
  }
}

function deleteMyHoldingScheme(){
  if(!confirm('确认删除已保存的"我的持有方案"？删除后，持仓诊断将无法给出加仓/减仓建议。')) return;
  try {
    localStorage.removeItem(MY_SCHEME_KEY);
    localStorage.removeItem(ACTION_HISTORY_KEY);
    if(typeof showToast === 'function') showToast('方案已删除', 'success');
    renderMyHoldingScheme();
    if(typeof renderActionDecisions === 'function'){
      try { renderActionDecisions(); } catch(_){}
    }
  } catch(e){
    console.warn('[我的持有方案] 删除失败:', e);
  }
}

function renderMyHoldingScheme(){
  const block = document.getElementById('my-scheme-block');
  const metaEl = document.getElementById('scheme-meta');
  const body = document.getElementById('my-scheme-body');
  const delBtn = document.getElementById('delete-scheme-btn');
  const saveHint = document.getElementById('scheme-save-hint');
  if(!block || !body) return;

  const scheme = loadMyHoldingScheme();
  if(!scheme){
    block.style.display = 'none';
    if(delBtn) delBtn.style.display = 'none';
    if(saveHint) saveHint.textContent = '保存后，持仓诊断将基于此方案给出加仓/减仓建议';
    return;
  }

  // 有已保存方案：显示折叠块 + 显示删除按钮
  block.style.display = '';
  if(delBtn) delBtn.style.display = '';

  // 过期判断
  const ageDays = Math.floor((Date.now() - scheme.savedAt) / 86400000);
  let currentPhase = null;
  try {
    if(typeof analyzeCategoryPerf === 'function' && typeof inferMomentumPhase === 'function' && CURATED_FUNDS.length > 0){
      const catRanks = analyzeCategoryPerf();
      const macro = inferMomentumPhase(catRanks);
      if(macro && macro.phase && macro.phase !== 'unknown') currentPhase = macro.phase;
    }
  } catch(_){ /* 数据未就绪时忽略 phase 对比 */ }

  const ageExpired = ageDays > 30;
  const phaseChanged = currentPhase && scheme.phase && currentPhase !== scheme.phase;

  // summary meta 简述
  if(metaEl){
    const ageText = ageDays === 0 ? '今天保存' : `${ageDays} 天前保存`;
    const warn = (ageExpired || phaseChanged) ? ' · ⚠️ 建议重新生成' : '';
    metaEl.textContent = `· ${ageText} · ${scheme.phaseLabel || scheme.phase || ''}${warn}`;
  }
  if(saveHint) saveHint.textContent = '再次生成方案并保存，将替换已有方案';

  // 过期横幅
  let banner = '';
  if(ageExpired){
    banner += `<div style="padding:10px 14px;background:#fffbe6;border-left:3px solid #faad14;border-radius:6px;font-size:12px;color:#ad6800;margin-bottom:10px;line-height:1.7">⚠️ 方案已保存 ${ageDays} 天，市场可能已变化，建议重新生成方案以获取最新配置。</div>`;
  }
  if(phaseChanged){
    banner += `<div style="padding:10px 14px;background:#fff7e6;border-left:3px solid #fa8c16;border-radius:6px;font-size:12px;color:#ad4e00;margin-bottom:10px;line-height:1.7">🔄 市场阶段已从 <b>${escHtml(scheme.phaseLabel || scheme.phase)}</b> 切换，当前配置可能不再适配，建议重新生成。</div>`;
  }

  // picks 列表按类别分组
  const byCat = {};
  (scheme.picks || []).forEach(p => {
    const c = p.cat || 'other';
    if(!byCat[c]) byCat[c] = [];
    byCat[c].push(p);
  });
  const catNames = { active:'主动型', index:'指数', bond:'债券', money:'货币', qdii:'QDII', other:'其他' };
  const rows = Object.entries(byCat).map(([cat, picks]) => {
    const sum = picks.reduce((s,p)=>s+(p.amt||0), 0);
    const sumPct = picks.reduce((s,p)=>s+(p.pct||0), 0);
    const items = picks.map(p => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:12px"><span>${escHtml(p.name)} <span style="color:var(--muted);font-size:11px">(${p.code})</span></span><span style="color:var(--primary);font-weight:600;white-space:nowrap">${p.pct}% · ¥${(p.amt||0).toLocaleString()}</span></div>`).join('');
    return `<div style="border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:6px;border-bottom:1px dashed var(--border)">
        <span style="font-size:13px;font-weight:600">${catNames[cat]||cat}</span>
        <span style="font-size:12px;color:var(--muted)">${sumPct.toFixed(0)}% · ¥${sum.toLocaleString()}</span>
      </div>
      ${items}
    </div>`;
  }).join('');

  body.innerHTML = `${banner}
    <div style="margin-bottom:10px;font-size:12px;color:var(--muted);line-height:1.7">
      保存时间：${scheme.savedAtDate} · 目标总额 ¥${(scheme.targetTotal||0).toLocaleString()} · ${scheme.risk || ''} · ${scheme.horizon || ''}年
    </div>
    ${rows}
    <div style="margin-top:8px;font-size:11px;color:var(--muted);line-height:1.6">
      💡 持仓诊断 tab 会基于此方案对比当前持仓，给出具体的加仓/减仓/首次买入建议。
    </div>`;
}


