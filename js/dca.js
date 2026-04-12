// ═══ 定投专区模块 ═══
function calcSIP(){
  const amount=parseFloat(document.getElementById('sip-amount').value)||0;
  const freq=parseInt(document.getElementById('sip-freq').value);
  const years=parseInt(document.getElementById('sip-years').value)||5;
  const rate=parseFloat(document.getElementById('sip-rate').value)/100;
  const init=parseFloat(document.getElementById('sip-init').value)||0;
  if(!amount||!rate){showToast('请填写投入金额和预期收益率','error');return;}
  const periods=years*freq, rPer=rate/freq;
  let totalCost=init, totalValue=init;
  const sipData=[], labels=[], costArr=[], valArr=[];
  for(let i=1;i<=periods;i++){
    totalValue=(totalValue+amount)*(1+rPer); totalCost+=amount;
    if(i%freq===0||i===periods){
      const yr=Math.ceil(i/freq); labels.push(`第${yr}年`);
      costArr.push(+(totalCost+init).toFixed(2)); valArr.push(+totalValue.toFixed(2));
      sipData.push({year:yr,cost:totalCost+init,value:totalValue});
    }
  }
  const fv=totalValue,fc=totalCost+init,profit=fv-fc,pct=((fv-fc)/fc*100).toFixed(2);
  document.getElementById('sip-stats').innerHTML=`
    <div class="stat-card"><div class="stat-val">¥${(amount*freq/12).toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="stat-label">月均投入</div></div>
    <div class="stat-card"><div class="stat-val">¥${fc.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="stat-label">总投入本金</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--primary)">¥${fv.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="stat-label">预期总资产</div></div>
    <div class="stat-card"><div class="stat-val ${profit>=0?'up':'down'}">¥${profit.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="stat-label">预期收益</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${pct>=0?'var(--success)':'var(--danger)'}">${pct>=0?'+':''}${pct}%</div><div class="stat-label">累计收益率</div></div>`;
  if(sipChartInst) { try{sipChartInst.destroy();}catch(e){} sipChartInst=null; }
  sipChartInst=new Chart(document.getElementById('sipChart'),{type:'bar',data:{labels,datasets:[{label:'投入本金',data:costArr,backgroundColor:'#bae0ff',borderRadius:4},{label:'预期市值',data:valArr,backgroundColor:'#1677ff',borderRadius:4}]},options:{plugins:{legend:{position:'bottom'}},scales:{y:{ticks:{callback:v=>'¥'+(v/10000).toFixed(0)+'万'}}},responsive:true,maintainAspectRatio:true}});
  document.getElementById('sip-table-wrap').innerHTML=`<details><summary style="cursor:pointer;font-size:13px;color:var(--primary);margin-bottom:8px">查看逐年明细 <span class="toggle-arrow" style="font-size:12px"></span></summary><div class="table-wrap"><table><thead><tr><th>年份</th><th>累计投入</th><th>预期市值</th><th>累计收益</th><th>收益率</th></tr></thead><tbody>${sipData.map(d=>{const p=d.value-d.cost,pc=(p/d.cost*100).toFixed(1);return`<tr><td>第${d.year}年</td><td>¥${d.cost.toLocaleString('zh-CN',{maximumFractionDigits:0})}</td><td style="color:var(--primary)">¥${d.value.toLocaleString('zh-CN',{maximumFractionDigits:0})}</td><td class="up">+¥${p.toLocaleString('zh-CN',{maximumFractionDigits:0})}</td><td class="up">+${pc}%</td></tr>`;}).join('')}</tbody></table></div></details>`;
  document.getElementById('sip-result').style.display='block';
}

// ═══════════════ 面板2: 定投推荐榜 ═══════════════
// calcDCAScore 已移至 js/score.js
let currentDcaCat = 'all';

function setDcaCat(cat){
  // DCA分类筛选已整合到精选基金库的统一分类中，此函数保留兼容性
  currentDcaCat = cat;
  setCategory(cat);
}

function renderDcaRanking(){
  // DCA排名已整合到精选基金库的排序切换中，此函数仅更新时间标签
  const catHasNav = Object.keys(navCache).length > 0;
  const timeEl = document.getElementById('dca-rank-time');
  if(timeEl && catHasNav){ const now=new Date(); timeEl.textContent=`净值更新于 ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`; }
  // 如果当前是定投排序模式，刷新市场列表
  if(currentSortMode==='dca') renderMarketGrid();
}

function updateDcaBudgetHint(){
  const activePlans = dcaPlans.filter(d => !d.paused);
  const totalExisting = activePlans.reduce((s,d)=>s+d.monthly,0);
  const hintEl = document.getElementById('dca-budget-hint');
  if(!hintEl) return;
  if(totalExisting > 0){
    hintEl.textContent = `（当前已有¥${totalExisting.toLocaleString()}/月，输入追加金额）`;
  } else {
    hintEl.textContent = '';
  }
}

function resetDcaGenButton(){
  const btn = document.getElementById('dca-gen-btn');
  if(btn && btn.disabled){
    btn.disabled = false;
    btn.innerHTML = '🤖 生成AI定投方案';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function generateDcaAiPlan(){
  updateDcaBudgetHint(); // 生成前更新提示
  const btn=document.getElementById('dca-gen-btn');
  if(btn){btn.classList.add('is-loading');btn.innerHTML='<span class="loading-dot"></span> 生成中…';}

  // 显示加载卡片，隐藏结果
  const loadCard = document.getElementById('dca-loading-card');
  const resultEl = document.getElementById('dca-ai-result');
  loadCard.style.display = 'block';
  resultEl.style.display = 'none';

  // 滚动到加载卡片
  setTimeout(() => loadCard.scrollIntoView({behavior:'smooth',block:'center'}), 100);

  // 显示算法执行步骤动画
  setTimeout(() => {
    const bar = document.getElementById('dca-loading-bar');
    const textEl = document.getElementById('dca-loading-text');
    const iconEl = document.getElementById('dca-loading-icon');
    const stepsEl = document.getElementById('dca-steps');

    stepsEl.style.display = 'block';
    stepsEl.innerHTML = '';
    bar.style.width = '0%';

    const algoSteps = [
      {icon:'📊',text:'分析已有定投计划，评估基金质量'},
      {icon:'📡',text:'市场行情分析（资产动量信号）'},
      {icon:'⚖️',text:'Risk Parity 动态权重计算'},
      {icon:'🔍',text:'多因子智能选基（去重+核心卫星）'},
      {icon:'💰',text:'优化金额分配，确保预算平衡'},
      {icon:'📈',text:'计算预期收益（均值回归模型）'},
      {icon:'✅',text:'生成专属定投方案'}
    ];

    let si = 0;
    function showAlgoStep(){
      if(si >= algoSteps.length) return;
      const s = algoSteps[si];
      iconEl.textContent = s.icon;
      textEl.textContent = s.text;
      bar.style.width = ((si + 1) / algoSteps.length * 100) + '%';

      const stepDiv = document.createElement('div');
      stepDiv.style.cssText = 'font-size:12px;line-height:1.8;color:var(--muted);opacity:0;transition:opacity .3s';
      stepDiv.innerHTML = `<span style="color:var(--success)">✓</span> ${s.text}`;
      stepsEl.appendChild(stepDiv);
      requestAnimationFrame(() => stepDiv.style.opacity = '1');

      si++;
      if(si < algoSteps.length){
        setTimeout(showAlgoStep, 350);
      } else {
        setTimeout(() => {
          try{ _doGenerateDca(); }catch(e){ console.error(e); }
          loadCard.style.display = 'none';
          if(btn){
            btn.classList.remove('is-loading');
            btn.innerHTML='✅ 已生成方案';
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';
          }
        }, 400);
      }
    }
    showAlgoStep();
  }, 300);
}
function _doGenerateDca(){
  const budget = parseFloat(document.getElementById('dca-budget').value)||1000;
  const risk = document.getElementById('dca-risk-pref').value;
  const years = parseInt(document.getElementById('dca-plan-years').value)||5;

  // 1. 分析已有定投计划（排除暂停的）
  const activePlans = dcaPlans.filter(d => !d.paused);
  const totalExistingMonthly = activePlans.reduce((s,d)=>s+d.monthly,0);

  // 按类别分组并评估质量
  const holdingPlansByCat = {};
  const replaceSuggestions = [];
  activePlans.forEach(plan => {
    const fd = CURATED_FUNDS.find(f => f.code === plan.code);
    if(!fd) return; // 未知基金跳过
    const cat = fd.cat;
    if(cat === 'money') return; // 货币基金不参与定投方案
    const dcaScore = calcDCAScore(fd);
    const keep = dcaScore >= 70; // 定投评分≥70为达标（提高阈值，确保推荐质量）
    if(!holdingPlansByCat[cat]) holdingPlansByCat[cat] = [];
    holdingPlansByCat[cat].push({ code:plan.code, name:plan.name||fd.name, monthly:plan.monthly, dcaScore, keep, fundData:fd });
    if(!keep) replaceSuggestions.push({ code:plan.code, name:plan.name||fd.name, cat, dcaScore, monthly:plan.monthly });
  });

  // 2. 行情分析 + 市场动量信号（复用智能推荐模块）
  const catRanks = analyzeCategoryPerf();
  const macroClock = inferMomentumPhase(catRanks);

  // 3. 动态权重计算（Risk Parity + 动量约束 + 期限约束）
  const dynamicWeights = computeWeights(risk, years, catRanks, macroClock);

  // 定投不含货币基金，将money权重按比例分配给其他类别
  const moneyW = dynamicWeights.money || 0;
  const dcaCats = ['active','index','bond','qdii'];
  const nonMoneyTotal = dcaCats.reduce((s,c) => s + (dynamicWeights[c]||0), 0);
  const riskWeightMap = {};
  dcaCats.forEach(c => {
    const base = dynamicWeights[c] || 0;
    riskWeightMap[c] = nonMoneyTotal > 0 ? (base + moneyW * base / nonMoneyTotal) / 100 : 0;
  });

  // 4. 计算每个类别的缺口
  // 用户输入的预算是"追加预算"，总预算 = 已有 + 追加
  const totalBudget = totalExistingMonthly + budget;
  const catGap = {};
  const catKept = {};
  dcaCats.forEach(cat => {
    const targetMonthly = totalBudget * (riskWeightMap[cat] || 0);
    const keptPlans = (holdingPlansByCat[cat] || []).filter(p => p.keep);
    const keptMonthly = keptPlans.reduce((s,p) => s + p.monthly, 0);
    catGap[cat] = Math.max(0, targetMonthly - keptMonthly);
    catKept[cat] = keptPlans;
  });
  const totalGap = Object.values(catGap).reduce((s,v) => s + v, 0);

  // 替换建议用的候选池（按定投评分排名）
  const dcaScoredPool = CURATED_FUNDS.filter(f => f.cat !== 'money')
    .map(f => ({...f, dcaScore: calcDCAScore(f)}))
    .sort((a,b) => b.dcaScore - a.dcaScore);

  // 5. 智能选基（融合已有计划，复用 selectFunds 多因子算法）
  const allPicks = [];

  dcaCats.forEach(cat => {
    const gap = catGap[cat] || 0;
    const kept = catKept[cat] || [];

    // A. 保留达标的已有计划
    kept.forEach(plan => {
      allPicks.push({
        ...plan.fundData,
        monthly: plan.monthly,
        dcaScore: plan.dcaScore,
        action: 'keep',
        actionLabel: '✓ 继续定投',
        isExisting: true
      });
    });

    // B. 为缺口使用 selectFunds 多因子选基（经理去重+标签过滤+核心卫星+动量反转）
    if(gap > 100) {
      const catData = catRanks.find(cr => cr.cat === cat);
      if(!catData) return;

      // 构建排除已选基金的候选池，叠加定投评分兜底过滤
      const filteredCatData = {
        ...catData,
        topFunds: catData.topFunds.filter(f =>
          !allPicks.some(p => p.code === f.code) &&
          calcDCAScore(f) >= 60
        )
      };

      // 计算该类别在总预算中的百分比（selectFunds 需要）
      const catPct = Math.round(gap / totalBudget * 100);
      if(catPct < 1 || filteredCatData.topFunds.length === 0) return;

      const fundPicks = selectFunds(cat, filteredCatData, risk, catPct, totalBudget);

      fundPicks.forEach(fp => {
        // selectFunds 返回的 amt 是按总额计算的一次性金额，转为月投金额
        const monthlyAmt = Math.max(100, Math.round(fp.amt / 100) * 100);
        allPicks.push({
          ...fp,
          monthly: monthlyAmt,
          dcaScore: calcDCAScore(fp),
          action: 'new',
          actionLabel: '+ 新增定投',
          isExisting: false
        });
      });
    }
  });

  // 6. 调整月投金额，确保总额等于总预算
  let totalAllocated = allPicks.reduce((s,p) => s + p.monthly, 0);
  if(totalAllocated !== totalBudget && allPicks.length > 0) {
    const diff = totalBudget - totalAllocated;
    // 优先调整新增的基金
    const adjustable = allPicks.filter(p => p.action === 'new');
    if(adjustable.length > 0) {
      const perFund = Math.round(diff / adjustable.length / 100) * 100;
      adjustable.forEach(p => p.monthly += perFund);
    } else {
      // 如果没有新增的，调整第一只
      allPicks[0].monthly += diff;
    }
  }

  // 7. 计算百分比
  const finalTotal = allPicks.reduce((s,p) => s + p.monthly, 0);
  allPicks.forEach(p => {
    p.pct = Math.round(p.monthly / finalTotal * 100);
  });

  const withAmt = allPicks;

  // 期望年化收益（与智能方案一致的均值回归模型）
  // 长期中枢 + 均值回归：expected = mu + (r3_annualized - mu) * (1 - revSpeed)
  const longTermMu = { active:3.5, index:4.0, bond:3, money:2, qdii:4.5 };
  const revSpeed = { active:0.35, index:0.35, bond:0.6, money:0.1, qdii:0.35 };
  const expRate = withAmt.reduce((s,f)=>{
    const mu = longTermMu[f.cat] || 6;
    const rev = revSpeed[f.cat] || 0.35;
    const r3Ann = f.r3 > -100 ? (Math.pow(1+f.r3/100, 1/3)-1)*100 : 0;
    const expected = mu + (r3Ann - mu) * (1 - rev);
    return s + expected * (f.pct/100);
  }, 0);
  const r = expRate/100/12;
  const periods = years*12;
  let val = 0;
  for(let i=1;i<=periods;i++) val = (val+totalBudget)*(1+r);
  const totalCost = totalBudget * periods;
  const profit = val - totalCost;

  const riskNames={conservative:'保守型',moderate:'稳健型',balanced:'平衡型',aggressive:'进取型'};

  // 分组：继续定投 vs 新增定投
  const keepPicks = withAmt.filter(f => f.action === 'keep');
  const newPicks = withAmt.filter(f => f.action === 'new');

  // 存入全局以供一键导入按钮使用（只导入新增的）
  window._lastDcaAiPicks = newPicks.map(f=>({code:f.code,name:f.name,monthly:f.monthly,type:f.type}));
  // 持久化到IndexedDB，防止刷新后丢失
  FundDB.set('lastDcaAiPicks', window._lastDcaAiPicks);

  const resultEl = document.getElementById('dca-ai-result');
  resultEl.style.display='block';

  // 构建UI
  let html = '';

  // 预算说明（如果有已有定投）
  if(totalExistingMonthly > 0) {
    html += `<div style="background:#f6ffed;border:1px solid #b7eb8f;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13px;line-height:1.8">
      <div style="color:#237804;font-weight:600;margin-bottom:4px">💰 预算说明</div>
      <div style="color:#595959">已有定投：<b>¥${totalExistingMonthly.toLocaleString()}/月</b>（${activePlans.length}只基金）</div>
      <div style="color:#595959">追加预算：<b>¥${budget.toLocaleString()}/月</b></div>
      <div style="color:#237804;font-weight:600">总预算：<b>¥${totalBudget.toLocaleString()}/月</b></div>
    </div>`;
  }

  // 市场动量信号展示（仅在有明确信号时显示）
  if(macroClock && macroClock.phase !== 'transition' && macroClock.phase !== 'unknown') {
    const phaseColors = {
      recovery:'#52c41a', global_bull:'#1677ff', overheat:'#ff4d4f',
      recession:'#faad14', stagflation:'#ff4d4f', qdii_opp:'#722ed1'
    };
    html += `<div style="background:#f9f0ff;border:1px solid #d3adf7;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:13px;line-height:1.8">
      <div style="color:#531dab;font-weight:600;margin-bottom:4px">📡 市场动量信号：<span style="color:${phaseColors[macroClock.phase]||'#531dab'}">${macroClock.label}</span></div>
      <div style="color:#595959">${macroClock.desc}</div>
      <div style="color:#8c8c8c;font-size:11px;margin-top:4px">权重已根据市场信号动态调整（权益×${macroClock.equityMult.toFixed(2)}，债券×${macroClock.bondMult.toFixed(2)}）</div>
    </div>`;
  }

  html += `
    <div style="background:#f0f8ff;border-radius:10px;padding:14px;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap;text-align:center">
      <div style="flex:1;min-width:90px"><div style="font-size:20px;font-weight:700;color:var(--primary)">¥${totalBudget.toLocaleString()}/月</div><div style="font-size:11px;color:var(--muted)">每月总定投</div></div>
      <div style="flex:1;min-width:90px"><div style="font-size:20px;font-weight:700;color:#722ed1">${years}年</div><div style="font-size:11px;color:var(--muted)">计划年限</div></div>
      <div style="flex:1;min-width:90px"><div style="font-size:20px;font-weight:700;color:var(--success)">¥${Math.round(totalCost).toLocaleString()}</div><div style="font-size:11px;color:var(--muted)">累计投入</div></div>
      <div style="flex:1;min-width:90px"><div style="font-size:20px;font-weight:700;color:var(--danger)">¥${Math.round(val).toLocaleString()}</div><div style="font-size:11px;color:var(--muted)">预期${years}年后</div></div>
    </div>`;

  // 继续定投部分
  if(keepPicks.length > 0) {
    html += `<div style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;color:var(--success);margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="font-size:16px">✓</span> 继续定投（${keepPicks.length}只）
      </div>
      <div style="border:1px solid #b7eb8f;border-radius:10px;overflow:hidden;background:#f6ffed">
        ${keepPicks.map((f,i)=>{
          const nav=navCache[f.code]; const chg=nav?parseFloat(nav.gszzl)||0:null;
          const todayStr=chg!==null?`<span style="font-size:11px;color:${chg>=0?'var(--danger)':'var(--success)'};margin-left:6px">今日${chg>=0?'+':''}${chg}%</span>`:'';
          return `<div class="dca-ai-item" style="background:#f6ffed">
            <div style="width:28px;text-align:center;font-size:14px;color:var(--success)">✓</div>
            <div class="dca-ai-fund">
              <div class="dca-ai-name">${f.name}${todayStr}</div>
              <div class="dca-ai-meta">代码 ${f.code} · ${f.manager} · 近1年 <span class="${f.r1>=0?'up':'down'}">${f.r1>=0?'+':''}${f.r1}%</span> · 定投评分 <b style="color:var(--success)">${f.dcaScore}</b></div>
            </div>
            <div class="dca-ai-bar"><div class="dca-ai-bar-fill" style="width:${f.pct}%;background:${CAT_COLORS[f.cat]||'#999'}"></div></div>
            <div class="dca-ai-pct">${f.pct}%</div>
            <div class="dca-ai-amt">¥${f.monthly.toLocaleString()}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // 新增定投部分
  if(newPicks.length > 0) {
    html += `<div style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;color:var(--primary);margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="font-size:16px">+</span> 新增定投（${newPicks.length}只）
      </div>
      <div style="border:1px solid #91caff;border-radius:10px;overflow:hidden">
        ${newPicks.map((f,i)=>{
          const nav=navCache[f.code]; const chg=nav?parseFloat(nav.gszzl)||0:null;
          const todayStr=chg!==null?`<span style="font-size:11px;color:${chg>=0?'var(--danger)':'var(--success)'};margin-left:6px">今日${chg>=0?'+':''}${chg}%</span>`:'';
          return `<div class="dca-ai-item">
            <div style="width:28px;text-align:center;font-size:14px;color:var(--primary)">+</div>
            <div class="dca-ai-fund">
              <div class="dca-ai-name">${f.name}${todayStr}</div>
              <div class="dca-ai-meta">代码 ${f.code} · ${f.manager} · 近1年 <span class="${f.r1>=0?'up':'down'}">${f.r1>=0?'+':''}${f.r1}%</span> · 定投评分 <b style="color:var(--primary)">${f.dcaScore}</b></div>
            </div>
            <div class="dca-ai-bar"><div class="dca-ai-bar-fill" style="width:${f.pct}%;background:${CAT_COLORS[f.cat]||'#999'}"></div></div>
            <div class="dca-ai-pct">${f.pct}%</div>
            <div class="dca-ai-amt">¥${f.monthly.toLocaleString()}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // 低分定投计划的替换建议
  if(replaceSuggestions.length > 0) {
    html += `<div style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;color:#d48806;margin-bottom:8px;display:flex;align-items:center;gap:6px">
        <span style="font-size:16px">⚠️</span> 建议调整（${replaceSuggestions.length}只）
      </div>
      <div style="border:1px solid #ffc53d;border-radius:10px;padding:12px;background:#fffbe6">
        ${replaceSuggestions.map(s => {
          const replacement = dcaScoredPool.find(f => f.cat === s.cat && !withAmt.some(p => p.code === f.code) && f.dcaScore >= 60);
          return `<div style="font-size:12px;line-height:1.8;color:#7c5800;margin-bottom:8px">
            <b>${s.name}</b>（${s.code}）当前月投¥${s.monthly} · 评分${s.dcaScore}分
            ${replacement ? `<br>→ 建议替换为 <b>${replacement.name}</b>（${replacement.code}，评分${replacement.dcaScore}分）` : '<br>→ 建议暂停或减少投入'}
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  html += `
    <div style="margin-top:10px;padding:10px 14px;background:#fffbe6;border-radius:8px;font-size:12px;color:#7c5800;line-height:1.7">
      💡 <b>方案说明（${riskNames[risk]}·${years}年）：</b>基于 Risk Parity 动态权重 + 市场动量信号 + 多因子选基算法生成。配置${withAmt.length}只基金，预期加权年化收益约 <b>${expRate.toFixed(1)}%</b>，${years}年后预估收益 <b>+¥${Math.round(profit).toLocaleString()}</b>（收益率 +${((profit/totalCost)*100).toFixed(1)}%）。${keepPicks.length > 0 ? `已保留${keepPicks.length}只达标的现有定投计划。` : ''}权重已根据当前市场状态${macroClock ? '（'+macroClock.label+'）' : ''}动态调整。定投建议每月固定日期执行，坚持不懈效果最佳。<br><span style="color:#ad6800">⚠️ 预期收益基于历史数据经均值回归折扣估算，仅供参考，不构成收益承诺。</span>
    </div>
    <div style="margin-top:8px">
      ${newPicks.length > 0 ? `<button class="btn btn-primary btn-sm" id="dca-import-btn" onclick="importDcaAiToPlan()">⬇ 一键加入${newPicks.length}只新增定投</button>` : '<div style="text-align:center;padding:10px;color:var(--success);font-size:13px">✓ 您的定投计划已经很完善，继续保持即可</div>'}
    </div>
    <details style="margin-top:14px">
      <summary style="cursor:pointer;font-size:13px;color:var(--primary);font-weight:500;padding:8px 0">📐 定投策略依据与算法说明 <span class="toggle-arrow" style="font-size:12px"></span></summary>
      <div style="padding:12px;background:#f8f9fc;border-radius:8px;font-size:12px;color:#595959;line-height:1.8;margin-top:8px">
        <div class="notice" style="padding:6px 10px;border-radius:6px;font-size:11px;margin-bottom:10px;border-left:none">📡 基金收益率、最大回撤、规模、经理任期等核心数据由天天基金网API实时拉取（每24小时自动更新），确保评分和方案基于最新市场数据。</div>

        <b>一、定投评分体系（4维+估值信号）</b><br>
        定投评分独立于基金通用评分，专门为「定期定额」场景设计：<br>
        · <b>波动适度性</b>（35%权重）：定投的核心优势是在波动中摊低成本（微笑曲线）。使用<b>钟形曲线</b>建模，各类别最优回撤不同（权益25%、QDII 20%、债券5%），波动过低无摊成本空间，过高散户易放弃。长期正收益(r3)越高，波动价值越大（r3加成40%）<br>
        · <b>长期趋势</b>（25%权重）：近3年累计收益r3，连续函数无分档断层。定投看长期中枢方向，不重度惩罚短期下跌<br>
        · <b>管理质量</b>（20%权重）：经理任期年限(满分12分，按任期×0.8计算) + 星级评定(满分8分，按(星级-1)×2计算)。定投周期长，经理稳定性直接影响风格延续<br>
        · <b>近期动量反转修正</b>（20%权重）：基于同类基金的z-score判断超涨/超跌。超涨(>均值+1σ)扣分——可能面临均值回归；超跌(<均值-1σ)但长期向上加分——定投摊成本黄金窗口<br>
        · <b>估值信号</b>（±10分，宽基指数专属）：基于PE百分位（近10年），≤20%低估+10分，≥80%高估-10分<br>
        特殊规则：货币基金波动极小不适合定投(固定10分)；r1和r3双负基金大幅降分但不完全排除（周期性底部仍有定投价值）<br><br>

        <b>二、资产配置方法（与智能推荐完全一致）</b><br>
        执行链路：风险平价基础 → 风险偏好倾斜 → 市场动量约束 → 行情动量微调 → 期限上限 → 短期额外调整<br>
        · <b>基础权重（Risk Parity）</b>：使用迭代法求解等风险贡献，考虑资产间相关性矩阵（股债负相关ρ=-0.15，股票-指数高相关ρ=0.92等）。通过10次迭代优化，使每个资产的边际风险贡献 MRC = w × (Σw) 趋于相等<br>
        · <b>风险偏好倾斜</b>：4档偏好(保守/稳健/平衡/进取)对各类别施加倾斜系数<br>
        · <b>市场动量约束</b>：基于资产相对强弱推断6种市场阶段（权益强势/债券强势/全面弱势等），动态调整权益/债券系数。${macroClock && macroClock.phase !== 'unknown' ? `当前信号：<b>${macroClock.label}</b>，权益系数×${macroClock.equityMult}，债券系数×${macroClock.bondMult}` : '当前信号模糊，采用中性配置'}<br>
        · <b>反转保护</b>：3层保护——①已被动量信号调高的类别，动量倾斜减半；②涨幅>30%不倾斜，>40%反向减配；③弱势类别若已跌>10%，不再减配（可能是底部区域）<br>
        · <b>期限约束</b>：权益上限——1年≤30%，1-3年≤60%，3-5年≤75%，5年以上≤85%<br>
        · <b>定投适配</b>：货币基金权重按比例重分配给其他4类（定投不投货币基金）<br><br>

        <b>三、类别内选基（与智能推荐完全一致）</b><br>
        · <b>风险过滤</b>：保守型只选R1-R3，稳健型R1-R4，其他允许所有。有回退机制，保守型选不出时放宽到R4<br>
        · <b>风险偏好感知排名</b>：保守型侧重低回撤+高稳定性，进取型侧重收益动量+高弹性<br>
        · <b>动量反转修正</b>：超涨基金(>均值+1σ)最多扣8分，超跌但长期向上基金(r3>0)最多加5分<br>
        · <b>相关性去重</b>：同一基金经理最多选1只，标签重叠>50%跳过<br>
        · <b>核心-卫星架构</b>：权重≥35%选3只，≥25%选2只，其他1只。核心仓40-60%（按评分差距自适应），单只不超30%<br>
        · <b>定投评分兜底</b>：selectFunds选出的基金还需定投评分≥60，确保适合定投场景<br><br>

        <b>四、收益预估（长期均值中枢 + 均值回归模型）</b><br>
        · 预期收益以各类别长期年化均值为中枢：<b>主动3.5%/指数4%/债券3%/货币2%/QDII 4.5%</b>（保守估算：剔除牛市后普通投资者实际获得收益约2-3%）<br>
        · 均值回归修正：expected = μ + (r3年化 - μ) × (1 - 回归速度)。回归速度：权益35%（~5年半衰期），债券60%（~2年半衰期），QDII 35%<br>
        · 加权组合收益按各基金占比计算，再用复利公式推算N年后总资产<br><br>

        <b>五、已有计划融合</b><br>
        · 对已有活跃定投计划按定投评分评估：≥70分达标保留，<70分建议替换<br>
        · 按类别计算"缺口"=目标配置金额-已有达标计划金额，仅为缺口选新基金<br>
        · 预算模型：用户输入为追加预算，总预算=已有月投+追加预算<br>
        · 月投金额最终调平，确保总月投=总预算（优先调整新增基金）
      </div>
    </details>`;

  resultEl.innerHTML = html;
  // 自动同步参数到收益测算
  document.getElementById('sip-amount').value = totalBudget;
  document.getElementById('sip-rate').value = expRate.toFixed(1);
  document.getElementById('sip-years').value = years;
  calcSIP();
  const hintEl=document.getElementById('sip-synced-hint');
  if(hintEl){hintEl.style.display='inline';setTimeout(()=>hintEl.style.display='none',5000);}
}

function importDcaAiToPlan(planArr){
  const doImport = (arr) => {
    if(!arr||!arr.length){ showToast('请先生成AI定投方案','error'); return; }
    let added = 0;
    arr.forEach(p=>{
      if(!dcaPlans.some(d=>d.code===p.code)){
        const today = new Date().toISOString().split('T')[0];
        dcaPlans.push({code:p.code, name:p.name, monthly:p.monthly, start:today, curval:0, type:p.type});
        added++;
      }
    });
    FundDB.set('dcaPlans', dcaPlans);
    renderDcaPlans();

    // 更新按钮状态
    const btn = document.getElementById('dca-import-btn');
    if(btn) {
      if(added > 0) {
        btn.textContent = `✓ 已加入${added}只到定投计划`;
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
        showToast(`已添加 ${added} 只基金到您的定投计划`,'success');
      } else {
        btn.textContent = '✓ 全部已在定投计划中';
        btn.disabled = true;
        btn.style.opacity = '0.6';
        btn.style.cursor = 'not-allowed';
        showToast('所有基金已在定投计划中','info');
      }
    } else {
      if(added>0){ showToast(`已添加 ${added} 只基金到您的定投计划`,'success'); }
      else { showToast('所有基金已在定投计划中','info'); }
    }
  };
  // 优先用参数/内存，其次从IndexedDB加载
  const arr = planArr || window._lastDcaAiPicks;
  if(arr && arr.length){ doImport(arr); return; }
  FundDB.get('lastDcaAiPicks').then(saved=>{
    doImport(saved||[]);
  }).catch(()=>{ showToast('请先生成AI定投方案','error'); });
}

function dpAutoFill(code){
  if(code.length!==6) return;
  const f = CURATED_FUNDS.find(x=>x.code===code);
  if(f){ document.getElementById('dp-name').value=f.name; document.getElementById('dp-type').value=f.type; }
}

function addDcaPlan(){
  const code=document.getElementById('dp-code').value.trim();
  const name=document.getElementById('dp-name').value.trim();
  const monthly=parseFloat(document.getElementById('dp-monthly').value)||0;
  const start=document.getElementById('dp-start').value;
  const curval=parseFloat(document.getElementById('dp-curval').value)||0;
  const type=document.getElementById('dp-type').value;
  const deductDay = parseInt(document.getElementById('dp-deduct-day').value) || 10;
  // 内联校验
  let hasErr=false;
  const searchEmpty = !code || !name;
  document.getElementById('dp-search').closest('.form-item').classList.toggle('has-error',searchEmpty);
  document.getElementById('dp-monthly').closest('.form-item').classList.toggle('has-error',!monthly);
  if(searchEmpty || !monthly) hasErr=true;
  if(hasErr){showToast(searchEmpty?'请先搜索并选择一只基金':'请填写每月定投金额','error');autoFadeErrors();return;}
  if(dcaPlans.some(d=>d.code===code)){showToast('该基金已在定投计划中','info');return;}
  dcaPlans.push({code,name,monthly,start,curval,type,deductDay});
  FundDB.set('dcaPlans',dcaPlans);
  renderDcaPlans(); flashSaved('dp-section');
  clearFundMatch('dp');
  ['dp-monthly','dp-curval'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('dca-ai-result').style.display='none';
}

function removeDcaPlan(i){
  const plan=dcaPlans[i]; if(!plan) return;
  if(!confirm(`确定删除「${plan.name}」的定投计划？`)) return;
  dcaPlans.splice(i,1);
  FundDB.set('dcaPlans',dcaPlans);
  renderDcaPlans(); renderExistingHoldings(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
  document.getElementById('dca-ai-result').style.display='none';
}

async function checkDcaReminder(){
  if(!dcaPlans.length) return;

  const today = new Date();
  const todayDay = today.getDate();
  const todayStr = today.toISOString().slice(0,10);

  // 检查今天是否已关闭提醒
  const dismissed = await FundDB.get('dcaReminderDismissed') || {};
  if(dismissed[todayStr]) return;

  // 查找今天需要定投的计划
  const todayPlans = dcaPlans.filter(p => p.deductDay === todayDay && !p.paused);
  if(!todayPlans.length) return;

  // 显示提醒
  const reminder = document.getElementById('dca-reminder');
  const desc = document.getElementById('dca-reminder-desc');
  desc.textContent = `今天是${todayPlans.map(p => `「${p.name}」`).join('、')}的定投日，记得在支付宝完成扣款`;
  reminder.style.display = 'block';

  // 发送浏览器通知
  if('Notification' in window && Notification.permission === 'granted'){
    try {
      new Notification('📅 定投提醒', {
        body: `今天有 ${todayPlans.length} 笔定投计划需要扣款`,
        icon: 'icons/icon-192.png',
        tag: 'dca-reminder-' + todayStr,
      });
    } catch(e){}
  }
}

async function dismissDcaReminder(){
  const todayStr = new Date().toISOString().slice(0,10);
  const dismissed = await FundDB.get('dcaReminderDismissed') || {};
  dismissed[todayStr] = true;
  await FundDB.set('dcaReminderDismissed', dismissed);
  document.getElementById('dca-reminder').style.display = 'none';
}

// 检查持仓确认提醒
async function checkHoldingConfirmReminder(){
  if(!existingHoldings.length) return;

  const todayStr = new Date().toISOString().slice(0,10);

  // 检查今天是否已关闭提醒
  const dismissed = await FundDB.get('holdingConfirmDismissed') || {};
  if(dismissed[todayStr]) return;

  // 查找需要确认的持仓
  const needConfirm = existingHoldings.filter(h =>
    h.status !== 'confirmed' && (h.confirmDate || '') <= todayStr
  );

  if(!needConfirm.length) return;

  // 发送浏览器通知
  if('Notification' in window && Notification.permission === 'granted'){
    try {
      new Notification('📌 持仓待确认', {
        body: `您有 ${needConfirm.length} 笔持仓已确认，请输入份额以获得准确数据`,
        icon: 'icons/icon-192.png',
        tag: 'holding-confirm-' + todayStr,
      });
    } catch(e){}
  }
}

// 检查赎回到账提醒
async function checkRedeemArrivalReminder(){
  const transactions = await FundDB.get('transactions') || [];
  const todayStr = new Date().toISOString().slice(0,10);

  // 检查今天是否已关闭提醒
  const dismissed = await FundDB.get('redeemArrivalDismissed') || {};
  if(dismissed[todayStr]) return;

  // 查找到账日期到了但还未标记到账的赎回记录
  const arrivedRedeems = transactions.filter(t =>
    t.type === 'redeem' && t.arrivalDate && t.arrivalDate <= todayStr && !t.arrived
  );

  if(!arrivedRedeems.length) return;

  // 发送浏览器通知
  if('Notification' in window && Notification.permission === 'granted'){
    try {
      const totalAmount = arrivedRedeems.reduce((sum, t) => sum + (t.amount || 0), 0);
      new Notification('💰 赎回到账提醒', {
        body: `您有 ${arrivedRedeems.length} 笔赎回已到账，总金额约 ¥${totalAmount.toLocaleString()}`,
        icon: 'icons/icon-192.png',
        tag: 'redeem-arrival-' + todayStr,
      });
    } catch(e){}
  }
}

// 显示持仓使用帮助
function showHoldingsHelp(){
  alert(`📖 我的持仓使用说明

1️⃣ 添加持仓
• 在搜索框输入基金名称或代码
• 填写买入金额、日期（份额可选）
• 点击"添加持仓"

2️⃣ 刷新净值
• 点击顶部"刷新净值数据"按钮
• 获取最新净值和今日收益
• 交易日9:30-15:00可查看实时估算

3️⃣ 确认份额
• 基金买入后需T+1或T+2确认
• 确认后点击"📌待确认"输入实际份额
• 在支付宝→基金→持仓中查看确认份额

4️⃣ 数据说明
• 数据来源：天天基金网 + 东方财富网
• 可能与支付宝有细微差异（数据源不同）
• 所有数据仅供参考，以支付宝为准`);
}

function showDataSourceInfo(){
  alert(`📊 收益数据说明

💡 数据来源
• 实时净值：天天基金网(fundgz)
• 历史数据：东方财富网
• 更新时间：交易日9:30-15:00实时估算

⚠️ 为什么与支付宝有差异？
• 数据源不同：本工具使用第三方数据源
• 更新时间差：可能存在几分钟延迟
• 计算方式：估算净值 vs 确认净值
• 份额精度：小数位数可能不同

✅ 如何保证准确性？
• 输入支付宝显示的"持有份额"（推荐）
• 定期刷新净值数据
• 以支付宝显示为准，本工具仅供参考

📌 温馨提示
本工具旨在帮助您更好地管理基金投资，所有数据仅供参考，实际收益请以支付宝为准。`);
}

function showProfitExplanation(){
  alert(`💰 收益指标说明

📊 总市值
• 当前所有基金持仓的总价值
• 计算：持有份额 × 当前净值

💵 累计盈亏
• 从买入至今的总收益（含现金分红）
• 计算：(当前市值 + 现金分红) - 持仓成本
• 显示金额和收益率百分比

📈 实时盈亏
• 从上次刷新到现在的收益变化
• 仅交易日9:30后显示
• 使用实时估算净值计算
• 显示数据更新时间
• 标注"实时估算"表示为估算值

📉 昨日收益
• 昨天一天的收益变化
• 使用确认净值精确计算
• 非交易日不显示

💡 温馨提示
• 实时估算数据供参考，以收盘后确认净值为准
• 非交易日（周末/节假日）净值不更新`);
}

// openModal、closeModal、confirmModal 已移至 js/utils.js
let _modalCb=null;
function editDcaPlan(i){
  const plan=dcaPlans[i]; if(!plan) return;
  openModal(`修改「${plan.name}」每月定投金额`,plan.monthly,function(val){
    const parsed=parseInt(val);
    if(!parsed||parsed<1){ showToast('请输入有效金额（≥1元）','error'); return; }
    if(parsed>100000){ showToast('单只基金月定投金额建议不超过10万元','error'); return; }
    dcaPlans[i].monthly=parsed;
    FundDB.set('dcaPlans',dcaPlans);
    renderDcaPlans();
    showToast(`已修改为 ¥${parsed}/月`,'success');
  });
}
function toggleDcaPause(i){
  const plan=dcaPlans[i]; if(!plan) return;
  dcaPlans[i].paused=!dcaPlans[i].paused;
  FundDB.set('dcaPlans',dcaPlans);
  renderDcaPlans();
  showToast(dcaPlans[i].paused?`已暂停「${plan.name}」定投`:`已恢复「${plan.name}」定投`,'info');
}

function clearDcaPlans(){
  if(!dcaPlans.length||confirm('确定清空全部定投计划？')){
    dcaPlans=[];
    FundDB.set('dcaPlans',dcaPlans);
    renderDcaPlans(); renderExistingHoldings(); runHealthMonitor(); renderTodayOverview(); runSignalEngine();
    document.getElementById('dca-ai-result').style.display='none';
  }
}

function renderDcaPlans(){
  const listEl=document.getElementById('dp-list');
  const emptyEl=document.getElementById('dp-empty');
  const summaryEl=document.getElementById('dp-summary');
  if(!dcaPlans.length){
    listEl.style.display='none'; emptyEl.style.display='block'; summaryEl.style.display='none';
    return;
  }
  emptyEl.style.display='none'; listEl.style.display='block';
  const totalMonthly=dcaPlans.reduce((s,d)=>s+d.monthly,0);
  const totalCurval=dcaPlans.reduce((s,d)=>s+d.curval,0);
  listEl.innerHTML=dcaPlans.map((d,i)=>{
    const nav=navCache[d.code];
    const chg=nav?parseFloat(nav.gszzl)||0:null;
    // 计算已定投月数
    const months=d.start?Math.max(0,Math.floor((new Date()-new Date(d.start))/30/86400000)):0;
    const invested=d.monthly*months;
    return `<div class="dp-item">
      <div class="dp-fund">
        <div class="dp-name">${escHtml(d.name)} <code class="code-copy" onclick="copyCode('${escHtml(d.code)}',this)" title="点击复制" style="font-size:11px;color:var(--muted)">${escHtml(d.code)}</code>${chg!==null?`<span style="margin-left:6px;font-size:11px;color:${chg>=0?'var(--danger)':'var(--success)'}">${chg>=0?'+':''}${chg}%</span>`:''}</div>
        <div class="dp-meta">${escHtml(d.type)}${d.start?` · 始于 ${fmtDateCN(d.start)}`:''} · 已定投约 ${months} 期 · 累计约 ¥${invested.toLocaleString()}${d.deductDay ? ` · 每月${d.deductDay}号扣款` : ''}</div>
      </div>
      <div class="dp-monthly"><div class="dp-monthly-val">¥${d.monthly.toLocaleString()}</div><div class="dp-monthly-lbl">每月定投</div></div>
      <div class="dp-total"><div class="dp-total-val">¥${d.curval>0?d.curval.toLocaleString():'--'}</div><div class="dp-total-lbl">当前市值</div></div>
      <div class="dp-actions">
        <button class="btn btn-ghost btn-sm" onclick="editDcaPlan(${i})" title="编辑金额">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleDcaPause(${i})" title="${d.paused?'恢复':'暂停'}">${d.paused?'▶️':'⏸️'}</button>
        <button class="btn btn-danger btn-sm" onclick="removeDcaPlan(${i})">删除</button>
      </div>
    </div>${d.paused?'<div style="padding:4px 14px 8px;font-size:11px;color:var(--warning)">⏸️ 已暂停定投</div>':''}`;
  }).join('');
  summaryEl.style.display='block';
  const activeCount=dcaPlans.filter(d=>!d.paused).length;
  const pausedCount=dcaPlans.length-activeCount;
  summaryEl.innerHTML=`📅 共 <b>${dcaPlans.length}</b> 项定投计划${pausedCount>0?`（${pausedCount}项已暂停）`:''}，每月合计 <b>¥${totalMonthly.toLocaleString()}</b>${totalCurval>0?`，总持仓市值约 <b>¥${totalCurval.toLocaleString()}</b>`:''}。已自动同步至已有持仓与持仓统计。<div style="font-size:11px;color:var(--muted);margin-top:6px">💡 每月扣款后，工具会自动按期数估算累计投入。如需精确跟踪，可在持仓中更新确认份额。</div>`;
  renderDcaTracker();
  // 更新定投预算提示
  updateDcaBudgetHint();
}

// 渲染定投跟踪
function renderDcaTracker(){
  const card=document.getElementById('dca-tracker-card');
  const list=document.getElementById('dca-tracker-list');
  if(!card||!list) return;

  const activePlans=dcaPlans.filter(d=>!d.paused);
  if(!activePlans.length){ card.style.display='none'; return; }

  card.style.display='block';
  const now=new Date();
  const thisMonth=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  list.innerHTML=activePlans.map((d,i)=>{
    const realIdx=dcaPlans.indexOf(d);
    if(!d.execLog) d.execLog={};
    const executed=d.execLog[thisMonth]||false;
    const nextDay=d.deductDay||10;
    const nextDate=now.getDate()>=nextDay?`下月${nextDay}号`:`本月${nextDay}号`;

    // 计算累计已投期数和金额
    const executedCount = Object.keys(d.execLog).filter(k => d.execLog[k]).length;
    const totalInvested = executedCount * d.monthly;

    return `<div style="padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:${executed?'#f6ffed':'#fff'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-weight:600;font-size:13px">${escHtml(d.name)}</div>
        <div style="font-size:12px;color:var(--muted)">¥${d.monthly}/月</div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">下次扣款：${nextDate}</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">累计已投：<b>${executedCount}</b>期 · 共<b>¥${totalInvested.toLocaleString()}</b></div>
      <div style="display:flex;gap:8px;align-items:center">
        ${executed
          ?`<span style="font-size:11px;color:var(--success);padding:4px 8px;background:#f6ffed;border-radius:4px;border:1px solid #b7eb8f">✅ 本月已执行</span>`
          :`<button class="btn btn-sm" onclick="markDcaExecuted(${realIdx})" style="font-size:11px;padding:4px 12px">✓ 标记已执行</button>`
        }
        <button class="btn btn-danger btn-sm" onclick="clearDcaTracking(${realIdx})" style="font-size:11px;padding:4px 12px" title="清空跟踪记录">🗑️ 清空</button>
      </div>
    </div>`;
  }).join('');
}

function markDcaExecuted(idx){
  const now=new Date();
  const thisMonth=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if(!dcaPlans[idx].execLog) dcaPlans[idx].execLog={};
  dcaPlans[idx].execLog[thisMonth]=true;
  FundDB.set('dcaPlans',dcaPlans);
  renderDcaTracker();
  showToast('已标记本月定投执行','success');
}

function clearDcaTracking(idx){
  const plan = dcaPlans[idx];
  if(!plan) return;
  const executedCount = plan.execLog ? Object.keys(plan.execLog).filter(k => plan.execLog[k]).length : 0;
  if(executedCount === 0){
    showToast('该定投计划暂无跟踪记录','info');
    return;
  }
  if(!confirm(`确定清空「${plan.name}」的跟踪记录？\n\n将清空${executedCount}期的执行记录，此操作不可恢复。`)) return;
  dcaPlans[idx].execLog = {};
  FundDB.set('dcaPlans',dcaPlans);
  renderDcaTracker();
  showToast('已清空跟踪记录','success');
}

// Panel1: 从定投计划导入到已有持仓
function importFromDcaPlans(){
  if(!dcaPlans.length){showToast('定投计划为空，请先在「我的资产」页添加','error');return;}
  let added=0;
  dcaPlans.forEach(d=>{
    if(!existingHoldings.some(e=>e.code===d.code)){
      const months=d.start?Math.max(0,Math.floor((new Date()-new Date(d.start))/30/86400000)):0;
      const invested=d.monthly*months;
      const curval=d.curval||invested;
      // cost = 估算平均买入净值：如果有市值和投入额，可以反推；否则用当前净值
      const nav=navCache[d.code];
      const curNav=nav?parseFloat(nav.gsz)||0:0;
      // 估算平均成本净值：invested/curval*curNav（假设当前份额=curval/curNav）
      const estCost = (curNav>0 && curval>0 && invested>0) ? (invested/(curval/curNav)) : (curNav||1);
      existingHoldings.push({code:d.code,name:d.name,amount:invested,date:d.start||new Date().toISOString().slice(0,10),status:'confirmed',type:d.type||'股票型',cost:estCost,value:curval,source:'dca'});
      added++;
    }
  });
  FundDB.set('existingHoldings',existingHoldings); markHoldingsChanged();
  renderExistingHoldings(); runHealthMonitor();
  if(added>0) showToast(`已从定投计划导入 ${added} 条持仓`,'success');
  else showToast('定投计划中的基金已全部在已有持仓中','info');
}

// ═══════════════ 智能买卖信号引擎（均衡型灵敏度） ═══════════════
let _lastSignalHash = ''; // 避免重复通知
let _lastDangerHash = ''; // 避免重复弹出危险信号弹窗

