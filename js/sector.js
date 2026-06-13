// 板块浏览模块
// 使用基金名称关键词归类（最稳定的信号），只对有明确主题的基金打板块标签
const SECTOR_KEYWORDS = [
  { sector: '半导体', kw: ['半导体','芯片','集成电路'] },
  { sector: '通信',   kw: ['通信','5G','CPO','光模块'] },
  { sector: '医药',   kw: ['医药','医疗','健康','生物','医院'] },
  { sector: '新能源', kw: ['新能源','光伏','储能','风电','锂电','电池'] },
  { sector: '消费',   kw: ['消费','白酒','食品','饮料'] },
  { sector: '科技',   kw: ['科技','互联网','人工智能','AI','数字','云计算'] },
  { sector: '红利',   kw: ['红利','高股息'] },
  { sector: '金融',   kw: ['金融','银行','券商','证券','保险'] },
  { sector: '军工',   kw: ['军工','国防','航天','航空'] },
  { sector: '资源',   kw: ['资源','有色','煤炭','石油','黄金','贵金属'] },
  { sector: '地产',   kw: ['地产','房地产','建筑','建材'] },
  { sector: '海外',   kw: ['纳斯达克','标普','美股','港股','恒生','日本','亚太','印度','越南'] },
  { sector: '宽基',   kw: ['沪深300','中证500','中证1000','上证50','创业板','全指','科创板'] },
];

function getFundSector(f) {
  for (const { sector, kw } of SECTOR_KEYWORDS) {
    if (kw.some(k => f.name.includes(k))) return sector;
  }
  if (f.cat === 'qdii') return '海外';
  if (f.cat === 'index') return '宽基';
  return null; // 均衡型主动基金不强行归板块
}

let _activeSector = null;

function renderSectorPanel() {
  const el = document.getElementById('sector-content');
  if (!el) return;
  if (!CURATED_FUNDS.length) {
    el.innerHTML = '<div style="color:var(--muted);padding:32px;text-align:center">精选库未加载，请稍候刷新</div>';
    return;
  }

  const map = {};
  CURATED_FUNDS.forEach(f => {
    const s = getFundSector(f);
    if (!s) return;
    (map[s] = map[s] || []).push(f);
  });
  Object.keys(map).forEach(s => map[s].sort((a, b) => scoreF(b) - scoreF(a)));

  const sectors = SECTOR_KEYWORDS.map(x => x.sector).filter(s => map[s]);

  if (!_activeSector || !map[_activeSector]) _activeSector = sectors[0];

  const chips = sectors.map(s => {
    const active = s === _activeSector;
    return `<span onclick="showSector('${s}')" style="cursor:pointer;padding:5px 14px;border-radius:16px;font-size:13px;border:1px solid ${active ? '#1677ff' : 'var(--border)'};background:${active ? '#1677ff' : '#fff'};color:${active ? '#fff' : 'var(--text)'};transition:all .15s">${s}<span style="font-size:11px;opacity:.7;margin-left:4px">${map[s].length}</span></span>`;
  }).join('');

  const list = (map[_activeSector] || []).slice(0, 5);
  const grid = list.length
    ? `<div class="fund-grid">${list.map(f => buildFundCard(f, 'score')).join('')}</div>`
    : '<div style="color:var(--muted);padding:32px;text-align:center">该板块暂无精选基金</div>';

  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${chips}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:12px">${_activeSector} · 共 ${(map[_activeSector]||[]).length} 只，按综合评分排名，显示前 ${list.length} 只</div>
    ${grid}`;
}

function showSector(s) {
  _activeSector = s;
  renderSectorPanel();
}
