# 回测模块说明

本目录为 fund-helper 的资产配置层回测工具（方案 A）。

## 目录结构

```
backtest/
├── README.md           # 本文件
├── envShim.js          # Node vm 加载器 + 浏览器环境 mock
├── runBacktest.js      # 回测主引擎
├── metrics.js          # 指标计算（夏普/Sortino/最大回撤/phase 命中率）
├── results.json        # 回测原始结果（月度收益序列、phase、权重）
├── metrics.json        # 汇总指标
└── findings.md         # 完整发现和优化建议
```

## 运行方式

```bash
node backtest/runBacktest.js   # 生成 results.json
node backtest/metrics.js       # 生成 metrics.json，打印汇总表
# 将 results.json + metrics.json + docs/backtest/index.html 一起部署
```

或直接打开本地报告：
```bash
cd docs/backtest && python3 -m http.server 8765
# 浏览器访问 http://localhost:8765/
```

## 输出报告

部署后可通过 `/backtest` 访问（vercel.json 已配置路由）。

## 方法论要点

1. **数据源**：`data/curated-details.json` 的 `marketBenchmarks.monthlyReturns`（4 类资产 × 36 个月）
2. **滚动窗口**：前 12 个月为初始估计窗口，有效回测期 24 个月
3. **月度 rebalance**：每月末重跑 `inferMomentumPhase` + `computeWeights`
4. **用户画像**：7 个 distinct（平衡/进取 × 1-5 年期限）
5. **基线**：等权、60/40、纯风险平价（去动量）、永久 recovery

## 重要约束

- ❌ **不修改 `js/` 下任何生产代码**，通过 Node `vm` 在隔离上下文中加载
- ✅ **算法跟生产完全一致**：直接 require `js/market.js` 和 `js/portfolio.js`
- ⚠️ **仅回测资产配置层**（类别间权重），不验证 scoreF 选基逻辑（需方案 B）

## 局限（详见 findings.md）

- 样本量仅 24 月，统计显著性弱
- 数据仅覆盖 2024-04 ~ 2026-03 牛市段，不含熊市验证
- 不含交易成本
