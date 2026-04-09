# 智能方案模块问题分析报告

## 问题汇总

### 问题1: 调仓金额总和12936≠新投入10000
**现象**: 用户输入新投入1万元，但调仓建议的金额加起来是12936元

**根本原因**:
`computeRebalancePlan()` 函数在计算调仓金额时，使用的是 `targetAmt - currentAmt` 的差值，但这个差值包含了：
1. 新增资金带来的目标仓位增加
2. 已有持仓的再平衡调整

代码位置: `js/portfolio.js:116`
```javascript
const diff = pick.newBuyAmt || (targetAmt - currentAmt);
```

当用户有已有持仓时，`targetAmt` 是基于 `portfolioTotal = existTotal + newMoney` 计算的，所以差值会大于 `newMoney`。

**修复方案**: 
- 调仓建议应该只显示"新增资金的分配"，而不是"目标仓位与当前仓位的差值"
- 需要区分"新买入金额"和"调仓金额"

---

### 问题2: 减仓11446后的资金未重新分配
**现象**: 提示减仓11446元，但没有说明这笔钱应该买什么

**根本原因**:
`computeRebalancePlan()` 只计算了每只基金的独立调仓动作，没有全局视角的资金流动分析。

代码逻辑缺陷:
1. 减仓操作只标记为 `action='reduce'`，没有计算释放的资金去向
2. 买入操作只基于新增资金，没有考虑减仓释放的资金

**修复方案**:
- 计算总释放资金 = 卖出金额 + 减仓金额
- 计算总需要资金 = 新增资金 + 总释放资金
- 在调仓建议中增加"资金流动总览"部分

---

### 问题3: 加仓金额显示负数¥-2,936
**现象**: 006738基金显示"加仓 ¥-2,936"

**根本原因**:
代码位置: `js/portfolio.js:134-137`
```javascript
} else if(diff>tol){
  action='buy_more'; actionAmt=diff;
  actionDesc=`加仓 ¥${diff.toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
```

当 `diff = targetAmt - currentAmt < 0` 时，应该是减仓，但由于某些逻辑分支，`diff` 为负数时仍然被标记为 `buy_more`。

可能的触发路径:
1. 基金在 `selectedPicks` 中，但 `targetAmt < currentAmt`
2. 由于容忍带判断 `diff > tol` 失败，但后续逻辑错误地设置了 `action='buy_more'`

**修复方案**:
- 在设置 `action='buy_more'` 前，强制检查 `diff > 0`
- 如果 `diff < 0`，应该走减仓逻辑

---

### 问题4: AI配置方案显示数据与实际持仓不一致
**现象**: 配置方案中显示的持仓金额与用户实际持仓不符

**根本原因**:
`_doGenerate()` 函数在融合已有持仓时，使用的是 `h.value`，但这个值可能：
1. 未刷新净值，使用的是旧数据
2. 计算逻辑与持仓模块不一致

代码位置: `js/portfolio.js:1048-1059`
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

**修复方案**:
- 在生成方案前，强制刷新 `existingHoldings` 的 `value` 字段
- 使用与持仓模块相同的净值计算逻辑

---

### 问题5: 006738持仓¥11,734但目标仓位为0，存在冲突
**现象**: 某基金显示持仓金额11734元，但目标仓位显示0元

**根本原因**:
这是问题4的延伸。当基金评分<60时，不会被保留在 `selectedPicks` 中，所以：
1. 在配置方案中，该基金不显示（或显示为0）
2. 在调仓建议中，该基金被标记为"建议卖出"或"卫星仓"

但由于渲染逻辑的问题，该基金可能同时出现在：
- 配置方案中（显示当前持仓）
- 调仓建议中（目标仓位0）

**修复方案**:
- 配置方案中不应该显示评分<60的基金
- 或者明确标注为"待调整"状态

---

### 问题6: 左上角显示10000但明细总金额40464
**现象**: 方案标题显示"¥10,000"，但基金明细加起来是40464元

**根本原因**:
代码位置: `js/portfolio.js:1409`
```javascript
document.getElementById('plan-subtitle').textContent=`${riskNames[riskP]} · ${horizonNames[horizon]} · ¥${totalAmt.toLocaleString()}`;
```

这里显示的是 `totalAmt`（新增资金），但实际方案是基于 `portfolioTotal = existTotal + totalAmt` 计算的。

**修复方案**:
- 标题应该显示 `portfolioTotal`（总资产）
- 或者明确标注"新增资金 ¥10,000 + 已有持仓 ¥30,464 = 总资产 ¥40,464"

---

## 核心问题总结

所有问题的根源是：**智能方案模块混淆了"新增资金"和"总资产"两个概念**

1. **计算层面**: 使用 `portfolioTotal` 计算目标配置
2. **展示层面**: 部分地方显示 `totalAmt`，部分地方显示 `portfolioTotal`
3. **调仓层面**: 混淆了"新资金分配"和"再平衡调整"

## 修复优先级

1. **P0 - 问题6**: 修复标题显示，让用户明确知道方案是基于多少资金
2. **P0 - 问题3**: 修复负数加仓的bug
3. **P1 - 问题1**: 调仓建议只显示新增资金的分配
4. **P1 - 问题2**: 增加资金流动总览
5. **P2 - 问题4/5**: 统一持仓数据来源和显示逻辑
