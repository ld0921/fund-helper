// 参数调整度量器：对比两份 metrics.json，输出 delta 表
// 用法：
//   node backtest/compare.js <baseline> <candidate> [--label=desc]
//   node backtest/compare.js backtest/baseline/metrics.json backtest/metrics.json --label="overheat阈值10→15"
const fs = require('fs');
const path = require('path');

function loadMetrics(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function indexByName(arr) {
  const o = {};
  arr.forEach(m => { o[m.name] = m; });
  return o;
}

function fmtDelta(baseline, candidate, fmt = 'number') {
  const d = candidate - baseline;
  if (Math.abs(d) < 0.005) return '—';
  const sign = d > 0 ? '+' : '';
  if (fmt === 'pp') return `${sign}${d.toFixed(2)}pp`;
  return `${sign}${d.toFixed(2)}`;
}

function colorize(d, better = 'up') {
  if (Math.abs(d) < 0.005) return '';
  const isImprovement = better === 'up' ? d > 0 : d < 0;
  return isImprovement ? '🟢' : '🔴';
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('用法: node compare.js <baseline.json> <candidate.json> [--label="描述"]');
    process.exit(1);
  }
  const [baselinePath, candidatePath, ...rest] = args;
  const labelArg = rest.find(a => a.startsWith('--label='));
  const label = labelArg ? labelArg.split('=')[1] : path.basename(candidatePath);

  const baseline = loadMetrics(baselinePath);
  const candidate = loadMetrics(candidatePath);
  const bi = indexByName(baseline);
  const ci = indexByName(candidate);

  const allNames = Array.from(new Set([...baseline.map(m => m.name), ...candidate.map(m => m.name)]));

  console.log(`\n━━━ 参数调整对比：${label} ━━━`);
  console.log(`基线：${baselinePath}`);
  console.log(`候选：${candidatePath}\n`);

  console.log('| 画像 | 累计% Δ | 年化% Δ | 波动% Δ | 回撤% Δ | 夏普 Δ | Sortino Δ | 胜率% Δ |');
  console.log('|---|---|---|---|---|---|---|---|');

  let totalDeltas = { sharpe: 0, cumulative: 0, maxDD: 0, count: 0 };
  let profileRows = [];

  allNames.forEach(name => {
    const b = bi[name], c = ci[name];
    if (!b || !c) return;
    const dCum = c.cumulative - b.cumulative;
    const dAnn = c.annualized - b.annualized;
    const dVol = c.annVol - b.annVol;
    const dDD = c.maxDD - b.maxDD;
    const dSharpe = c.sharpe - b.sharpe;
    const dSortino = c.sortino - b.sortino;
    const dWin = c.winRate - b.winRate;

    const isBase = name.includes('基线');
    const nameStr = isBase ? `<span style="color:#999">${name}</span>` : `**${name}**`;
    const row = `| ${nameStr} | ${colorize(dCum)}${fmtDelta(b.cumulative, c.cumulative, 'pp')} | ${colorize(dAnn)}${fmtDelta(b.annualized, c.annualized, 'pp')} | ${colorize(dVol, 'down')}${fmtDelta(b.annVol, c.annVol, 'pp')} | ${colorize(dDD, 'down')}${fmtDelta(b.maxDD, c.maxDD, 'pp')} | ${colorize(dSharpe)}${fmtDelta(b.sharpe, c.sharpe)} | ${colorize(dSortino)}${fmtDelta(b.sortino, c.sortino)} | ${colorize(dWin)}${fmtDelta(b.winRate, c.winRate, 'pp')} |`;
    console.log(row);
    profileRows.push({ name, isBase, dCum, dSharpe, dDD });

    if (!isBase) {
      totalDeltas.sharpe += dSharpe;
      totalDeltas.cumulative += dCum;
      totalDeltas.maxDD += dDD;
      totalDeltas.count++;
    }
  });

  if (totalDeltas.count > 0) {
    const avgSharpe = totalDeltas.sharpe / totalDeltas.count;
    const avgCum = totalDeltas.cumulative / totalDeltas.count;
    const avgDD = totalDeltas.maxDD / totalDeltas.count;
    console.log(`\n### 算法画像平均变化（不含基线）\n`);
    console.log(`- 累计收益 Δ: ${fmtDelta(0, avgCum, 'pp')}`);
    console.log(`- 夏普 Δ: ${fmtDelta(0, avgSharpe)}`);
    console.log(`- 最大回撤 Δ: ${fmtDelta(0, avgDD, 'pp')}（${avgDD < 0 ? '回撤降低=改善' : '回撤增大=恶化'}）`);
  }

  console.log(`\n### 判定参考标准\n`);
  console.log('- 🟢 改善：夏普↑ 且 累计↑；或 累计↑ 且 回撤↓；或 三项至少两项改善');
  console.log('- 🟡 中性：各指标变化 < 0.02 夏普 / < 1pp 累计');
  console.log('- 🔴 恶化：夏普↓ 且 累计↓；或 累计基本持平但回撤↑ > 2pp');

  // 自动判定
  const algoRows = profileRows.filter(r => !r.isBase);
  const improved = algoRows.filter(r => r.dSharpe > 0 && r.dCum > 0).length;
  const worsened = algoRows.filter(r => r.dSharpe < 0 && r.dCum < 0).length;
  const neutral = algoRows.length - improved - worsened;

  console.log(`\n### 自动判定`);
  console.log(`- 🟢 改善画像数: ${improved}/${algoRows.length}`);
  console.log(`- 🟡 中性画像数: ${neutral}/${algoRows.length}`);
  console.log(`- 🔴 恶化画像数: ${worsened}/${algoRows.length}`);

  const verdict = improved > worsened ? '🟢 建议保留' :
                  worsened > improved ? '🔴 建议回滚' :
                  '🟡 影响中性，根据具体指标判断';
  console.log(`\n**总体判定：${verdict}**`);

  // 输出 JSON 摘要供后续消费
  const summary = {
    label,
    baselinePath, candidatePath,
    timestamp: new Date().toISOString(),
    avgSharpe: totalDeltas.count > 0 ? totalDeltas.sharpe / totalDeltas.count : 0,
    avgCumulative: totalDeltas.count > 0 ? totalDeltas.cumulative / totalDeltas.count : 0,
    avgMaxDD: totalDeltas.count > 0 ? totalDeltas.maxDD / totalDeltas.count : 0,
    improvedCount: improved, worsenedCount: worsened, neutralCount: neutral,
    totalProfiles: algoRows.length,
    verdict,
  };
  return summary;
}

if (require.main === module) {
  const summary = main();
  // 追加写入调整日志
  const logPath = path.resolve(__dirname, 'tuning-log.json');
  let log = [];
  if (fs.existsSync(logPath)) {
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch (e) {}
  }
  log.push(summary);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`\n✓ 已记入 ${path.relative(path.resolve(__dirname, '..'), logPath)}`);
}

module.exports = { main };
