// ═══ 定投专区模块 ═══

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

function _startDcaAnimation(btn, loadCard){
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

function generateDcaAiPlan(){
  updateDcaBudgetHint();
  const btn=document.getElementById('dca-gen-btn');
  if(btn){btn.classList.add('is-loading');btn.innerHTML='<span class="loading-dot"></span> 生成中…';}

  const loadCard = document.getElementById('dca-loading-card');
  const resultEl = document.getElementById('dca-ai-result');
  loadCard.style.display = 'block';
  resultEl.style.display = 'none';
  setTimeout(() => loadCard.scrollIntoView({behavior:'smooth',block:'center'}), 100);

  // 若精选库净值未全部加载，先刷新再启动动画
  if(!window._allNavLoaded){
    refreshAllNav(false, false); // 非静默，用户可见加载进度
    const timer = setInterval(() => {
      if(window._allNavLoaded){
        clearInterval(timer);
        _startDcaAnimation(btn, loadCard);
      }
    }, 300);
    return;
  }

  _startDcaAnimation(btn, loadCard);
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
    const keepThreshold = cat === 'bond' ? 40 : cat === 'index' ? 45 : 55; // 比选基阈值低5分，避免边界波动导致刚选入就被推翻
    const keep = dcaScore >= keepThreshold;
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
      // 阈值按类别差异化：权益类60分，债券/指数波动小天然低分，放宽到45分
      const dcaScoreThreshold = ['bond'].includes(cat) ? 45 : ['index'].includes(cat) ? 50 : 60;
      const excluded = catData.topFunds.filter(f => !allPicks.some(p => p.code === f.code));
      const qualified = excluded.filter(f => calcDCAScore(f) >= dcaScoreThreshold);
      // 若阈值过滤后整个类别为空（如市场整体高位），回退到该类别评分最高的Top3
      const topFunds = qualified.length > 0 ? qualified : excluded.slice(0, 3);
      const filteredCatData = { ...catData, topFunds };
      const catPct = Math.round(gap / totalBudget * 100);
      if(catPct < 1 || filteredCatData.topFunds.length === 0) return;

      const fundPicks = selectFunds(cat, filteredCatData, risk, catPct, totalBudget);

      fundPicks.forEach(fp => {
        allPicks.push({
          ...fp,
          monthly: 0, // 先占位，后续统一按比例分配月投金额
          dcaScore: calcDCAScore(fp),
          action: 'new',
          actionLabel: '+ 新增定投',
          isExisting: false
        });
      });
    }
  });

  // 6. 按比例分配月投金额（一次性计算，确保总额精确等于 totalBudget）
  const newPart = allPicks.filter(p => p.action === 'new');
  const keptTotal = allPicks.filter(p => p.action === 'keep').reduce((s,p) => s + p.monthly, 0);
  const newBudget = totalBudget - keptTotal; // 新增基金可分配的月投额度

  if(newPart.length > 0 && newBudget > 0) {
    // 用 selectFunds 返回的 pct 作为比例基准
    const totalPct = newPart.reduce((s,p) => s + (p.pct||1), 0);
    let remaining = newBudget;
    // 先按比例分配（取整到百元）
    newPart.forEach((p, i) => {
      if(i < newPart.length - 1) {
        p.monthly = Math.max(100, Math.round(newBudget * (p.pct||1) / totalPct / 100) * 100);
        remaining -= p.monthly;
      } else {
        // 最后一只拿剩余额度，确保总额精确
        p.monthly = Math.max(100, remaining);
      }
    });
  }

  // 7. 重新计算百分比（基于最终月投金额）
  const finalTotal = allPicks.reduce((s,p) => s + p.monthly, 0);
  allPicks.forEach(p => {
    p.pct = Math.round(p.monthly / finalTotal * 100);
  });
  // 修正百分比舍入误差
  const pctSum = allPicks.reduce((s,p) => s + p.pct, 0);
  if(pctSum !== 100 && allPicks.length > 0) {
    allPicks.sort((a,b) => b.monthly - a.monthly)[0].pct += (100 - pctSum);
  }

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
    </div>`;

  resultEl.innerHTML = html;
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
    resetDcaGenButton();
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

// 通用帮助弹窗
function showHelpModal(title, contentHtml){
  const modal=document.getElementById('help-modal');
  if(!modal) return;
  document.getElementById('help-modal-title').textContent=title;
  document.getElementById('help-modal-content').innerHTML=contentHtml;
  modal.style.display='flex';
  requestAnimationFrame(()=>modal.classList.add('show'));
}
function closeHelpModal(){
  const modal=document.getElementById('help-modal');
  if(!modal) return;
  modal.classList.remove('show');
  setTimeout(()=>{ modal.style.display='none'; }, 200);
}

// 显示持仓使用帮助
function showHoldingsHelp(){
  showHelpModal('📖 我的持仓使用说明', `
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">1️⃣ 添加持仓</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px">在搜索框输入基金名称或6位代码</p>
        <p style="margin:0 0 6px">填写买入金额、日期（份额可选但推荐填写）</p>
        <p style="margin:0 0 6px">选择买入时间（15:00前/后，影响确认日期）</p>
        <p style="margin:0">点击「添加持仓」</p>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">2️⃣ 净值刷新</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px"><b>自动刷新：</b>每5分钟自动刷新 / 页面切回时自动刷新 / 登录后数据过期自动刷新</p>
        <p style="margin:0">交易日9:30后可查看盘中估算净值，收盘后使用确认净值</p>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">3️⃣ 确认份额</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px">基金买入后需T+1（15:00前）或T+2（15:00后）确认</p>
        <p style="margin:0 0 6px">确认日到达后点击「📌 待确认」输入实际份额</p>
        <p style="margin:0 0 6px">在支付宝→财富→基金→持仓中查看确认份额</p>
        <p style="margin:0">同基金多次买入确认后会自动合并</p>
      </div>
    </div>
    <div style="background:#f0f5ff;border:1px solid #adc6ff;border-radius:8px;padding:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#1d39c4">💡 数据说明</div>
      <p style="margin:0;font-size:12px;line-height:1.6">数据来源：天天基金网（实时估算）+ 东方财富网（确认净值）<br>可能与支付宝有细微差异（数据源不同），所有数据仅供参考，以支付宝为准</p>
    </div>
  `);
}

function showDataSourceInfo(){
  showHelpModal('📊 收益数据说明', `
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">💡 数据来源</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px"><b>实时净值：</b>天天基金网(fundgz)</p>
        <p style="margin:0 0 6px"><b>历史数据：</b>东方财富网</p>
        <p style="margin:0"><b>更新时间：</b>交易日9:30-15:00实时估算</p>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:#d46b08">⚠️ 为什么与支付宝有差异？</div>
      <div style="padding-left:12px;border-left:3px solid #fff7e6">
        <p style="margin:0 0 6px"><b>数据源不同：</b>本工具使用第三方数据源</p>
        <p style="margin:0 0 6px"><b>更新时间差：</b>可能存在几分钟延迟</p>
        <p style="margin:0 0 6px"><b>计算方式：</b>估算净值 vs 确认净值</p>
        <p style="margin:0"><b>份额精度：</b>小数位数可能不同</p>
      </div>
    </div>
    <div style="background:#f6ffed;border:1px solid #b7eb8f;border-radius:8px;padding:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#237804">✅ 如何保证准确性？</div>
      <p style="margin:0;font-size:12px;line-height:1.6">输入支付宝显示的「持有份额」（推荐）<br>定期刷新净值数据<br>以支付宝显示为准，本工具仅供参考</p>
    </div>
  `);
}

function showProfitExplanation(){
  showHelpModal('💰 收益指标说明', `
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">📊 总市值</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px">当前所有已确认基金持仓的总价值（待确认持仓单独显示）</p>
        <p style="margin:0 0 6px"><b>计算：</b>持有份额 × 当前净值（优先使用盘中估算净值gsz，其次使用确认净值dwjz）</p>
        <p style="margin:0">无份额数据时降级为：买入金额 ÷ 买入成本净值 × 当前净值</p>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">💵 累计盈亏</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px">从买入至今的总收益（含现金分红）</p>
        <p style="margin:0 0 6px"><b>计算：</b>(当前市值 + 现金分红) - 持仓成本</p>
        <p style="margin:0">同时持有直购和定投基金时，分别显示两类收益</p>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:700;margin-bottom:10px;color:var(--primary)">📈 实时盈亏</div>
      <div style="padding-left:12px;border-left:3px solid #e6f4ff">
        <p style="margin:0 0 6px">今日相对昨日收盘的收益变化，仅交易日9:30后显示</p>
        <p style="margin:0 0 6px"><b>优先使用：</b>份额 × (当前估算净值 - 昨日确认净值)</p>
        <p style="margin:0">无昨日净值时降级为：市值 × 估算涨跌幅</p>
      </div>
    </div>
    <div style="background:#f0f5ff;border:1px solid #adc6ff;border-radius:8px;padding:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:#1d39c4">💡 温馨提示</div>
      <p style="margin:0;font-size:12px;line-height:1.6">实时估算数据供参考，以收盘后确认净值为准<br>非交易日（周末/节假日）净值不更新<br>货币基金单位净值固定为1.00，不计入实时涨跌</p>
    </div>
  `);
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
  renderDcaPnlSummary();
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

// ═══════════════ 定投收益统计（基于实际持仓数据） ═══════════════
function renderDcaPnlSummary(){
  const el = document.getElementById('dca-pnl-summary');
  if(!el) return;

  const dcaHoldings = existingHoldings.filter(h => h.source === 'dca' && h.status === 'confirmed');
  if(!dcaHoldings.length){
    el.innerHTML = '';
    return;
  }

  const totalCost = dcaHoldings.reduce((s,h) => s + (h.amount||0), 0);
  const totalVal = dcaHoldings.reduce((s,h) => s + (h.value||0), 0);
  const totalCashDiv = dcaHoldings.reduce((s,h) => s + (h.totalCashDividend||0), 0);
  const totalPnl = totalCost > 0 ? (totalVal + totalCashDiv - totalCost) : 0;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
  const pnlColor = totalPnl >= 0 ? '#cf1322' : '#389e0d';
  const pnlBg = totalPnl >= 0 ? '#fff1f0' : '#f6ffed';
  const pnlBorder = totalPnl >= 0 ? '#ffccc7' : '#b7eb8f';

  const details = dcaHoldings.map(h => {
    const cost = h.amount || 0;
    const cashDiv = h.totalCashDividend || 0;
    const pnl = cost > 0 ? (h.value + cashDiv - cost) : 0;
    const pct = cost > 0 ? (pnl / cost * 100) : 0;
    return { name: h.name, code: h.code, cost, value: h.value||0, pnl, pct };
  }).sort((a,b) => b.value - a.value);

  el.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="icon icon-purple">📊</span>定投收益统计</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px">
        <div style="padding:10px 12px;background:#f0f5ff;border-radius:8px;border:1px solid #adc6ff">
          <div style="font-size:12px;color:#2f54eb;margin-bottom:4px">累计投入</div>
          <div style="font-size:18px;font-weight:700;color:#1d39c4">¥${totalCost.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        <div style="padding:10px 12px;background:#e6f7ff;border-radius:8px;border:1px solid #91d5ff">
          <div style="font-size:12px;color:#096dd9;margin-bottom:4px">当前市值</div>
          <div style="font-size:18px;font-weight:700;color:#0050b3">¥${totalVal.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        <div style="padding:10px 12px;background:${pnlBg};border-radius:8px;border:1px solid ${pnlBorder}">
          <div style="font-size:12px;color:${pnlColor};margin-bottom:4px">定投收益${totalCashDiv > 0 ? '(含分红)' : ''}</div>
          <div style="font-size:18px;font-weight:700;color:${pnlColor}">${totalPnl>=0?'+':''}¥${Math.abs(totalPnl).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>
        <div style="padding:10px 12px;background:${pnlBg};border-radius:8px;border:1px solid ${pnlBorder}">
          <div style="font-size:12px;color:${pnlColor};margin-bottom:4px">收益率</div>
          <div style="font-size:18px;font-weight:700;color:${pnlColor}">${totalPnl>=0?'+':''}${totalPnlPct.toFixed(2)}%</div>
        </div>
      </div>
      ${details.length > 0 ? `
      <details>
        <summary style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:13px;color:var(--primary);font-weight:500;padding:8px 0">
          各定投基金收益明细 <span class="toggle-arrow" style="font-size:12px"></span>
        </summary>
        <div class="table-wrap" style="margin-top:8px">
          <table style="width:100%;font-size:12px">
            <thead><tr><th style="text-align:left">基金名称</th><th style="text-align:right">投入</th><th style="text-align:right">市值</th><th style="text-align:right">盈亏</th><th style="text-align:right">收益率</th></tr></thead>
            <tbody>${details.map(d => `<tr>
              <td style="font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.name)}</td>
              <td style="text-align:right;color:var(--muted)">¥${d.cost.toLocaleString('zh-CN',{maximumFractionDigits:0})}</td>
              <td style="text-align:right">¥${d.value.toLocaleString('zh-CN',{maximumFractionDigits:0})}</td>
              <td style="text-align:right" class="${d.pnl>=0?'up':'down'}">${d.pnl>=0?'+':''}¥${Math.abs(d.pnl).toLocaleString('zh-CN',{maximumFractionDigits:2})}</td>
              <td style="text-align:right;font-weight:600" class="${d.pnl>=0?'up':'down'}">${d.pnl>=0?'+':''}${d.pct.toFixed(1)}%</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </details>` : ''}
      <div style="margin-top:8px;font-size:11px;color:var(--muted);line-height:1.5">
        💡 数据基于已导入到持仓的定投基金（标记为"📅 定投"），收益 = 当前市值 + 累计分红 - 买入成本。请先在持仓中确认份额以获得准确数据。
      </div>
    </div>`;
}

// ═══════════════ 智能买卖信号引擎（均衡型灵敏度） ═══════════════
let _lastSignalHash = ''; // 避免重复通知
let _lastDangerHash = ''; // 避免重复弹出危险信号弹窗

