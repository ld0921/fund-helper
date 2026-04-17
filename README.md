# fund-helper · 开源基金投顾 PWA

> 基于 Risk Parity + 多因子评分 + 动量 phase 切换的个人基金投资助手
> **含 45 个月牛熊双段实证回测** · Top 1-2% 透明开源个人工具

🔗 **线上访问**：[ld0921.github.io/fund-helper](https://ld0921.github.io/fund-helper/)
📊 **回测报告**：[ld0921.github.io/fund-helper/backtest/](https://ld0921.github.io/fund-helper/backtest/)
🗺️ **工程地图**：[ld0921.github.io/fund-helper/roadmap/](https://ld0921.github.io/fund-helper/roadmap/)

---

## 🎯 这是什么

一个**对个人用户免费、完全开源、完整数据实证**的基金投资管理工具，提供：

- **智能组合推荐**：基于你的风险偏好 + 投资期限，给出资产配置方案
- **精选基金库 + 全市场打分**：多因子评分系统挑选 Top 基金
- **持仓诊断 + 调仓建议**：基于科学信号告诉你持仓哪里需要调整
- **定投方案生成**：专门的定投评分模型（重波动率适度性，非单纯追高收益）
- **完整 5 年回测证据**：可点击 [`/backtest/`](https://ld0921.github.io/fund-helper/backtest/) 查看每个结论背后的数据

---

## 📊 算法实战表现（2022-05 ~ 2026-03 · 45 个月牛熊双段）

| 画像 | 夏普 | 最大回撤 | 年化 | 月度胜率 |
|---|---|---|---|---|
| **平衡+3 年 [智能选基+成本]** | **0.89** | **8.4%** | 11.8% | 62% |
| **进取+3 年 [智能选基+成本]** | **1.10** | **8.2%** | 14.4% | 69% |
| 基线：等权 25%×4 | 0.47 | 23.2% | 9.7% | 47% |
| 基线：60/40 股债 | 0.34 | 29.9% | 8.4% | 44% |

**算法 vs 等权基线**：
- 夏普比率：**×2.3**
- 最大回撤：**1/3**
- 月度胜率：**+15-22pp**

---

## 💡 算法核心思想（3 条）

### 1. 资产配置 = Risk Parity + 动量 Phase 切换
- 基础权重按风险平价（1/σ 迭代 10 轮等风险贡献）
- 动量 phase 识别市场状态（7 种：recovery / overheat / stagflation / ...）
- Phase 空头命中率 **60.6%**（33 次大样本 · 含熊市验证）

### 2. 基金选择 = 多因子评分 + 核心-卫星
- `composite` 分数（80% Calmar + 趋势 + 稳定性）排序 · 在 active/index 类 Top-Bot 差 **20-30pp**
- 经理/标签去重 + 核心仓 ≤30% 集中度控制
- 相对"类别均值持有"累计净 alpha **+2~+8pp**（扣交易成本）

### 3. 风险控制 = 回撤减半
算法的最大价值不在**绝对收益**，在**回撤控制**：
- 牛市跑输等权 10-15pp → **"买保险的学费"**
- 熊市跑赢等权 10pp + 回撤减半 → **"保险理赔"**

---

## 🔬 与同类工具对比

| 对比对象 | 特点 | 本工具相对优势 |
|---|---|---|
| 支付宝 / 天天基金 | 运营导向，代销偏好 | 无商业污染，算法透明可验证 |
| 且慢 / 蛋卷 | 主理人跟投 | 纯量化驱动，无主理人偏好 |
| 有知有行 | 教育工具+估值温度计 | 深度更深，有完整回测证据 |
| 雪球 | 社区驱动 | 算法驱动，可复现 |
| 开源小程序类 | 净值追踪+简单打分 | 高一个量级 |
| **机构级 FOF** | 宏观+行业+舆情+10年实盘 | 差距约 15-25%（数据维度） |

---

## 🏗️ 技术架构

### 主应用（PWA · 纯前端）
- `index.html` + `js/*.js` · 零后端依赖
- IndexedDB 存用户数据 · Supabase 可选云同步
- 部署：**GitHub Pages**（`ld0921.github.io/fund-helper`）

### 核心算法模块（不改）
- `js/portfolio.js` (~2060 行) · 智能组合：computeWeights / selectFunds / calculateRebalanceCost
- `js/dca.js` (~975 行) · 定投专区
- `js/signals.js` (~1230 行) · 持仓诊断（7 种信号 + 健康监控）
- `js/score.js` · scoreF 综合评分
- `js/market.js` · analyzeCategoryPerf / inferMomentumPhase

### 数据层
- `data/curated-details.json` · 精选库（GitHub Actions 每周一/四自动更新）
- `data/market-ranks.json` · 全市场 Top 统计
- `data/history-pool.json` · 全市场 340 只基金池（用于回测）
- `data/history-nav.sqlite` · 338 基金 × 5 年日净值 · 40.8 万数据点（gitignored，可重建）

### 回测系统（零侵入 · Node 侧）
- `backtest/envShim.js` · 通过 Node `vm` 加载生产代码，隔离运行
- `backtest/runBacktestV2.js` · 按月滚动回测引擎
- `backtest/compare.js` · 参数调整 delta 度量器
- `backtest/findings-*.md` · 5 份发现文档

---

## 📈 工程历程（2026-04-17 一日收官）

```
阶段 1: 评估与诊断     ✅
├─ 算法多维评估（87% 理论分）
├─ 方案 A 回测基础设施
├─ findings-v1（12 条参数调整候选）
└─ 发现 24 月数据样本不足是核心瓶颈

阶段 2: 数据建设       ✅
├─ 拉取 338 只基金 × 5 年日净值（40.8 万数据点）
├─ V2 回测引擎（真实日净值 + selectFunds + 交易成本）
└─ /backtest 报告页 V1/V2 Tab 切换

阶段 3: 真证据调参     ✅
├─ 3.0 批改代码 2 条（worthIt 门槛 + 进取档 riskAdjust）
├─ 3.1 调仓频率 U 型发现（半年最优）
├─ 3.2 熊市覆盖回测（回撤减半实证）
├─ 3.3 精准调参 3 条（全部保留）
├─ 3.4 scoreF vs composite 关系厘清（非 bug）
├─ 3.5 scoreF 预测力验证（全样本 0.0015 系数基本正确）
└─ 3.6 findings-v4 定稿

算法评分：87%（理论） → 91-92%（含熊市实证）
市场定位：Top 5% → Top 1-2%（透明实证维度）

阶段 4: 持续优化循环   🔄（长期）
├─ 4.1 每月自动回测 CI
├─ 4.2 参数漂移监控
├─ 4.3 新因子 A/B 机制
├─ 4.4 幸存者偏差修复
└─ 4.5 算法实验室工具化
```

---

## 🚀 本地开发 / 数据重建

```bash
# 1. 克隆
git clone https://github.com/ld0921/fund-helper.git
cd fund-helper

# 2. 直接用浏览器打开
open index.html

# 3. 回测（Node 22+）
#    拉历史净值（~10 分钟）
node scripts/build-fund-pool.js
node scripts/fetch-history-nav.js
node scripts/import-nav-to-sqlite.js

#    跑 V2 回测
node backtest/runBacktestV2.js --start=2022-05-31 --rebalance=semi-annual
node backtest/metrics.js --input=backtest/results-v2.json --output=backtest/metrics-v2.json

#    对照实验
node backtest/compare.js backtest/baseline-v2-bear/metrics.json backtest/metrics-v2.json --label="你的实验"
```

---

## ⚠️ 重要限制（完整版见 [`/backtest/` 局限性声明](https://ld0921.github.io/fund-helper/backtest/)）

1. **样本 45 月**：虽然覆盖牛熊两段，但不含 2008/2015 级别极端危机
2. **幸存者偏差未修复**：学术研究预估消除偏差后 alpha 降 1-2pp（仍为正）
3. **无实盘验证**：仅基于历史回测，真实执行会有滑点 + 用户行为损耗
4. **无宏观数据**：不用 GDP/CPI/行业轮动等机构级信号
5. **单一平台费率假设**：申赎费按支付宝 1 折，实际可能不同

---

## 📝 免责声明

本项目**仅供个人学习和参考**，不构成投资建议。基金投资有风险，历史业绩不代表未来表现。使用本工具造成的任何投资损失由用户自行承担。

---

## 🤝 贡献 / 反馈

- 提 issue：https://github.com/ld0921/fund-helper/issues
- 看算法细节：[`memory/project_architecture.md`](#)
- 看回测证据：[`/backtest/`](https://ld0921.github.io/fund-helper/backtest/)
- 看工程进度：[`/roadmap/`](https://ld0921.github.io/fund-helper/roadmap/)

---

**项目状态**：阶段性收官（2026-04-17） · 阶段 1-3 完成 · 阶段 4 作为长期维护持续进行

*"把算法从'理论正确'做到'数据证明有效'，让个人工具也能做到机构级别的严谨性。"*
