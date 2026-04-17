// 评估指标：复利累计、年化、波动、最大回撤、夏普、Sortino、月度胜率、phase 命中率
const fs = require('fs');
const path = require('path');

const RISK_FREE_ANNUAL = 0.017; // 1.7%

function cumulativeReturn(monthlyReturns) {
  // 复利累计收益 (%)
  let cum = 1;
  monthlyReturns.forEach(r => { cum *= (1 + r / 100); });
  return (cum - 1) * 100;
}

function annualizedReturn(monthlyReturns) {
  const cum = 1 + cumulativeReturn(monthlyReturns) / 100;
  const years = monthlyReturns.length / 12;
  return (Math.pow(cum, 1 / years) - 1) * 100;
}

function annualizedVolatility(monthlyReturns) {
  const n = monthlyReturns.length;
  const mean = monthlyReturns.reduce((a, b) => a + b, 0) / n;
  const variance = monthlyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const monthlyStd = Math.sqrt(variance);
  return monthlyStd * Math.sqrt(12); // 年化
}

function maxDrawdown(monthlyReturns) {
  let peak = 1, cum = 1, maxDD = 0;
  monthlyReturns.forEach(r => {
    cum *= (1 + r / 100);
    if (cum > peak) peak = cum;
    const dd = (peak - cum) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  });
  return maxDD;
}

function sharpe(monthlyReturns) {
  const annRet = annualizedReturn(monthlyReturns);
  const annVol = annualizedVolatility(monthlyReturns);
  if (annVol === 0) return 0;
  return (annRet / 100 - RISK_FREE_ANNUAL) / (annVol / 100);
}

function sortino(monthlyReturns) {
  // 下行波动
  const monthlyRF = Math.pow(1 + RISK_FREE_ANNUAL, 1 / 12) - 1; // 月度 RF
  const downside = monthlyReturns.map(r => Math.min(0, r / 100 - monthlyRF));
  const n = monthlyReturns.length;
  const downVar = downside.reduce((a, b) => a + b * b, 0) / n;
  const downStd = Math.sqrt(downVar) * Math.sqrt(12);
  const annRet = annualizedReturn(monthlyReturns);
  if (downStd === 0) return 0;
  return (annRet / 100 - RISK_FREE_ANNUAL) / downStd;
}

function winRate(monthlyReturns) {
  const wins = monthlyReturns.filter(r => r > 0).length;
  return wins / monthlyReturns.length * 100;
}

function computeMetrics(r) {
  return {
    name: r.name,
    profile: r.profile,
    months: r.monthlyReturns.length,
    cumulative: cumulativeReturn(r.monthlyReturns),
    annualized: annualizedReturn(r.monthlyReturns),
    annVol: annualizedVolatility(r.monthlyReturns),
    maxDD: maxDrawdown(r.monthlyReturns),
    sharpe: sharpe(r.monthlyReturns),
    sortino: sortino(r.monthlyReturns),
    winRate: winRate(r.monthlyReturns),
  };
}

// phase 命中率：当月预测 phase 方向 vs 下月权益类实际涨跌
// 权益定义：active + index + qdii 的等权平均月度收益
function phaseHitRate(result, seqs) {
  const { phases, monthlyReturns, weightHistory } = result;
  // weightHistory[i].t 是时点索引；该月权益收益用 seqs 取
  let bullishCorrect = 0, bullishTotal = 0;
  let bearishCorrect = 0, bearishTotal = 0;

  const bullishPhases = new Set(['recovery', 'global_bull']);
  const bearishPhases = new Set(['overheat', 'stagflation', 'recession']);

  weightHistory.forEach(w => {
    const t = w.t;
    const eqRet = ['active', 'index', 'qdii']
      .map(c => seqs[c] ? seqs[c][t] : 0)
      .reduce((a, b) => a + b, 0) / 3;
    if (bullishPhases.has(w.phase)) {
      bullishTotal++;
      if (eqRet > 0) bullishCorrect++;
    } else if (bearishPhases.has(w.phase)) {
      bearishTotal++;
      if (eqRet < 0) bearishCorrect++;
    }
  });

  return {
    bullishHit: bullishTotal > 0 ? (bullishCorrect / bullishTotal * 100) : null,
    bearishHit: bearishTotal > 0 ? (bearishCorrect / bearishTotal * 100) : null,
    bullishCount: bullishTotal,
    bearishCount: bearishTotal,
  };
}

function phaseTransitions(phases) {
  let count = 0;
  for (let i = 1; i < phases.length; i++) {
    if (phases[i] !== phases[i - 1]) count++;
  }
  return count;
}

function main() {
  const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'results.json'), 'utf8'));
  const rows = data.results.map(r => {
    const m = computeMetrics(r);
    // phase 命中率（仅对非固定权重的 profile 计算）
    if (r.profile && !r.profile.overridePhase && r.profile.riskProfile) {
      m.phaseMetrics = phaseHitRate(r, data.seqs);
      m.phaseTransitions = phaseTransitions(r.phases);
    }
    return m;
  });

  // 输出汇总表（markdown）
  console.log('\n| 画像 | 复利累计% | 年化% | 年化波动% | 最大回撤% | 夏普 | Sortino | 胜率% |');
  console.log('|---|---|---|---|---|---|---|---|');
  rows.forEach(r => {
    console.log(`| ${r.name} | ${r.cumulative.toFixed(2)} | ${r.annualized.toFixed(2)} | ${r.annVol.toFixed(2)} | ${r.maxDD.toFixed(2)} | ${r.sharpe.toFixed(2)} | ${r.sortino.toFixed(2)} | ${r.winRate.toFixed(1)} |`);
  });

  // phase 诊断
  console.log('\n### Phase 诊断（仅非固定 phase 的画像）\n');
  console.log('| 画像 | phase切换次数 | 多头判断命中率 | 空头判断命中率 |');
  console.log('|---|---|---|---|');
  rows.forEach(r => {
    if (r.phaseMetrics) {
      const bh = r.phaseMetrics.bullishHit !== null ? r.phaseMetrics.bullishHit.toFixed(1) + `% (${r.phaseMetrics.bullishCount}次)` : '无';
      const bs = r.phaseMetrics.bearishHit !== null ? r.phaseMetrics.bearishHit.toFixed(1) + `% (${r.phaseMetrics.bearishCount}次)` : '无';
      console.log(`| ${r.name} | ${r.phaseTransitions} | ${bh} | ${bs} |`);
    }
  });

  fs.writeFileSync(path.resolve(__dirname, 'metrics.json'), JSON.stringify(rows, null, 2));
  console.log(`\n✓ 指标已写入 backtest/metrics.json`);
  return rows;
}

if (require.main === module) main();

module.exports = { computeMetrics, phaseHitRate, cumulativeReturn, annualizedReturn };
