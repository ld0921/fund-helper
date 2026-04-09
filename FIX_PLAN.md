# 智能方案模块修复方案

## 修复策略

### 核心思路：区分"配置方案"和"调仓建议"

1. **配置方案（AI智能配置）**: 展示目标资产配置结构
   - 显示总资产 = 已有持仓 + 新增资金
   - 显示每只基金的目标金额和占比
   - 标注哪些是"已持有"，哪些是"新买入"

2. **调仓建议**: 展示如何从当前状态到达目标状态
   - 只显示需要操作的基金
   - 明确区分：卖出、减仓、新买、加仓、持有
   - 显示资金流动：释放多少 → 买入多少

---

## 具体修复步骤

### Step 1: 修复问题6（标题显示）

**位置**: `js/portfolio.js:1409`

**修改前**:
```javascript
document.getElementById('plan-subtitle').textContent=`${riskNames[riskP]} · ${horizonNames[horizon]} · ¥${totalAmt.toLocaleString()}`;
```

**修改后**:
```javascript
const subtitleText = existTotal > 0 
  ? `${riskNames[riskP]} · ${horizonNames[horizon]} · 总资产 ¥${portfolioTotal.toLocaleString()}（已有 ¥${existTotal.toLocaleString()} + 新增 ¥${totalAmt.toLocaleString()}）`
  : `${riskNames[riskP]} · ${horizonNames[horizon]} · ¥${totalAmt.toLocaleString()}`;
document.getElementById('plan-subtitle').textContent = subtitleText;
```

---

### Step 2: 修复问题3（负数加仓）

**位置**: `js/portfolio.js:129-137`

**修改前**:
```javascript
} else if(pick.newBuyAmt && pick.newBuyAmt > 0){
  action='buy_more'; actionAmt=pick.newBuyAmt;
  actionDesc=`加仓 ¥${pick.newBuyAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
  actionColor='act-buy_more';
} else if(diff>tol){
  action='buy_more'; actionAmt=diff;
  actionDesc=`加仓 ¥${diff.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
  actionColor='act-buy_more';
```

**修改后**:
```javascript
} else if(pick.newBuyAmt && pick.newBuyAmt > 0){
  action='buy_more'; actionAmt=pick.newBuyAmt;
  actionDesc=`加仓 ¥${pick.newBuyAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
  actionColor='act-buy_more';
} else if(diff>tol && diff > 0){ // 强制检查diff>0
  action='buy_more'; actionAmt=diff;
  actionDesc=`加仓 ¥${diff.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
  actionColor='act-buy_more';
```

---

### Step 3: 修复问题1和2（调仓金额和资金流动）

**位置**: `js/portfolio.js:291-301` (renderRebalancePlan)

**在summary后增加资金流动说明**:

```javascript
const summary={
  existTotal, newMoney, totalPortfolio,
  sellAmt:  actions.filter(a=>a.action==='sell').reduce((s,a)=>s+a.actionAmt,0),
  reduceAmt:actions.filter(a=>a.action==='reduce'||a.action==='reduce_gentle').reduce((s,a)=>s+a.actionAmt,0),
  buyAmt:   actions.filter(a=>['buy','buy_more'].includes(a.action)).reduce((s,a)=>s+a.actionAmt,0),
  totalRelease: 0, // 将在下面计算
  totalNeed: 0,
};
summary.totalRelease = summary.sellAmt + summary.reduceAmt;
summary.totalNeed = summary.buyAmt;
```

**修改渲染逻辑**:

```javascript
const releaseAmt=summary.sellAmt+summary.reduceAmt;
const flowBalance = summary.newMoney + releaseAmt - summary.buyAmt;

document.getElementById('rebal-summary').innerHTML=`
  <div class="rebal-sum-item"><div class="rebal-sum-val">¥${summary.existTotal.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">当前持仓总值</div></div>
  <div class="rebal-sum-item"><div class="rebal-sum-val">¥${summary.newMoney.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">新增可投资金</div></div>
  <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--danger)">¥${releaseAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">减持释放资金</div></div>
  <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--success)">¥${summary.buyAmt.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">建议买入总额</div></div>
  <div class="rebal-sum-item"><div class="rebal-sum-val" style="color:var(--primary)">¥${summary.totalPortfolio.toLocaleString('zh-CN',{maximumFractionDigits:0})}</div><div class="rebal-sum-lbl">调整后总资产</div></div>`;

// 增加资金流动说明
if(releaseAmt > 0){
  const flowHtml = `<div style="margin-top:12px;padding:10px 14px;background:#e6f7ff;border-radius:8px;border-left:3px solid var(--primary)">
    <div style="font-size:12px;font-weight:600;color:var(--primary);margin-bottom:4px">💰 资金流动说明</div>
    <div style="font-size:11px;color:#595959;line-height:1.8">
      • 减持释放：¥${releaseAmt.toLocaleString()} （卖出 ¥${summary.sellAmt.toLocaleString()} + 减仓 ¥${summary.reduceAmt.toLocaleString()}）<br>
      • 新增资金：¥${summary.newMoney.toLocaleString()}<br>
      • 可用总额：¥${(summary.newMoney + releaseAmt).toLocaleString()}<br>
      • 建议买入：¥${summary.buyAmt.toLocaleString()}<br>
      ${Math.abs(flowBalance) > 1 ? `• 结余：¥${flowBalance.toLocaleString()}（${flowBalance > 0 ? '可继续投资或留作备用金' : '需补充资金'}）` : ''}
    </div>
  </div>`;
  document.getElementById('rebal-summary').insertAdjacentHTML('afterend', flowHtml);
}
```

---

### Step 4: 修复问题4和5（持仓数据一致性）

**位置**: `js/portfolio.js:1048-1059`

**修改前**:
```javascript
existingHoldings.forEach(h=>{
  const fd = CURATED_FUNDS.find(f=>f.code===h.code);
  const cat = fd ? fd.cat : null;
  if(!cat) return;
  const score = scoreF(fd);
  const keep = score >= 60;
  if(!holdingsByCat[cat]) holdingsByCat[cat] = [];
  holdingsByCat[cat].push({ code:h.code, name:h.name||fd.name, value:h.value, score, keep, fundData:fd });
```

**修改后**:
```javascript
existingHoldings.forEach(h=>{
  const fd = CURATED_FUNDS.find(f=>f.code===h.code);
  const cat = fd ? fd.cat : null;
  if(!cat) return;
  
  // 使用最新净值计算当前市值
  const nav = navCache[h.code];
  const curNav = nav ? parseFloat(nav.gsz)||1 : 1;
  const currentValue = h.amount ? (h.amount / (h.cost||curNav) * curNav) : (h.value||0);
  
  const score = scoreF(fd);
  const keep = score >= 60;
  if(!holdingsByCat[cat]) holdingsByCat[cat] = [];
  holdingsByCat[cat].push({ 
    code:h.code, 
    name:h.name||fd.name, 
    value:currentValue, // 使用计算后的最新市值
    score, 
    keep, 
    fundData:fd 
  });
  
  // 只有评分<60且已确认的持仓才建议替换
  if(!keep && h.status === 'confirmed') {
    replaceSuggestions.push({ 
      code:h.code, 
      name:h.name||fd.name, 
      cat, 
      score, 
      value:currentValue 
    });
  }
});
```

---

## 测试检查清单

修复完成后，需要验证：

- [ ] 问题1: 调仓金额总和 = 新增资金 + 减持释放
- [ ] 问题2: 显示资金流动说明
- [ ] 问题3: 不再出现负数加仓
- [ ] 问题4: 配置方案中的持仓金额与资产页一致
- [ ] 问题5: 低分基金不在配置方案中显示，只在调仓建议中显示
- [ ] 问题6: 标题明确显示总资产构成
