#!/usr/bin/env node
// 基于现有 topStocks 数据和最新的 stock-industry-map.json
// 重新计算精选库所有基金的 sector 字段
// 用途：手动补充股票行业映射后，不重新拉取数据即可生效

const fs = require('fs');
const path = require('path');

const INDUSTRY_GROUP = {
  '通信设备': '通信', '通信服务': '通信', '元件': '通信',
  '半导体': '电子', '光学光电子': '电子', '消费电子': '电子',
  '计算机设备': '电子', '其他电子Ⅱ': '电子',
  '软件开发': '科技', 'IT服务Ⅱ': '科技', '互联网服务': '科技',
  '化学制药': '医药', '中药Ⅱ': '医药', '生物制品': '医药',
  '医药商业': '医药', '医疗器械': '医药', '医疗服务': '医药',
  '白酒Ⅱ': '消费', '食品加工': '消费', '饮料乳品': '消费',
  '调味发酵品Ⅱ': '消费', '休闲食品': '消费', '家居用品': '消费',
  '服装家纺': '消费', '化妆品': '消费', '小家电': '消费',
  '白色家电': '消费', '黑色家电': '消费', '厨卫电器': '消费',
  '电池': '新能源', '光伏设备': '新能源', '风电设备': '新能源',
  '电网设备': '新能源', '电机Ⅱ': '新能源', '其他电源设备Ⅱ': '新能源',
  '汽车零部件': '汽车', '汽车整车': '汽车', '商用车': '汽车',
  '乘用车': '汽车', '汽车服务': '汽车',
  '股份制银行Ⅱ': '金融', '城商行Ⅱ': '金融', '国有大型银行Ⅱ': '金融',
  '农商行Ⅱ': '金融', '证券Ⅱ': '金融', '保险Ⅱ': '金融',
  '多元金融': '金融',
  '煤炭开采': '资源', '石油开采': '资源', '油气开采Ⅱ': '资源',
  '工业金属': '资源', '小金属': '资源', '贵金属': '资源',
  '钢铁': '资源', '化学原料': '资源', '化学制品': '资源',
  '化学纤维': '资源', '橡胶': '资源', '塑料': '资源',
  '军工电子Ⅱ': '军工', '航空装备Ⅱ': '军工', '航天装备Ⅱ': '军工',
  '地面兵装Ⅱ': '军工', '航海装备Ⅱ': '军工',
  '房地产开发': '地产', '基础建设': '地产', '专业工程': '地产',
  '装修建材': '地产', '水泥': '地产', '玻璃玻纤': '地产',
  '电力': '公用', '燃气Ⅱ': '公用', '环境治理': '公用',
};

function inferFundSector(topStocks, stockMap) {
  if (!topStocks || topStocks.length === 0) return null;
  const groupWeight = {}, industryWeight = {};
  let mappedTotal = 0;
  topStocks.forEach(s => {
    const entry = stockMap[s.code];
    if (entry && entry.industry) {
      industryWeight[entry.industry] = (industryWeight[entry.industry] || 0) + s.pct;
      const group = INDUSTRY_GROUP[entry.industry] || entry.industry;
      groupWeight[group] = (groupWeight[group] || 0) + s.pct;
      mappedTotal += s.pct;
    }
  });
  if (mappedTotal < 10) return null;
  const sortedGroup = Object.entries(groupWeight).sort((a, b) => b[1] - a[1]);
  if (sortedGroup.length > 0 && sortedGroup[0][1] > 25) return sortedGroup[0][0];
  const sortedIndustry = Object.entries(industryWeight).sort((a, b) => b[1] - a[1]);
  if (sortedIndustry.length > 0 && sortedIndustry[0][1] > 30) return sortedIndustry[0][0];
  return null;
}

function main() {
  const curatedPath = path.join(__dirname, '..', 'data', 'curated-details.json');
  const mapPath = path.join(__dirname, '..', 'data', 'stock-industry-map.json');

  const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));
  const stockMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8')).stocks;

  let updated = 0, unchanged = 0, skipped = 0;
  Object.values(curated.funds).forEach(f => {
    if (!f.topStocks || f.topStocks.length === 0) { skipped++; return; }
    const newSector = inferFundSector(f.topStocks, stockMap);
    const oldSector = f.sector;
    if (newSector) {
      if (oldSector !== newSector) {
        console.log(`  ${f.name}: ${oldSector || '(无)'} → ${newSector}`);
        f.sector = newSector;
        f.sectorSource = 'topStocks';
        updated++;
      } else {
        unchanged++;
      }
    }
  });

  // ── 概念归因 ─────────────────────────────────────────────────────────────
  // 注：当前数据不适用于概念归因（详见下方说明），仅做清理防止脏数据残留
  // - ETF联接基金：topStocks 反映 feeder 的现金持仓（~1%NAV），pct≈0.01%
  // - LOF指数基金：直接持股，pct真实，但碰巧重仓CPO股≠CPO主题基金
  // - 主动基金：AI行情下普遍重仓CPO股，归因噪声极大
  // 启用条件：获取ETF本体（非联接A）的成分股权重后再重新评估
  Object.values(curated.funds).forEach(f => { delete f.concepts; });

  fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2), 'utf-8');
  console.log(`\n完成: 更新 ${updated} 只，未变 ${unchanged} 只，跳过 ${skipped} 只（无topStocks）`);
}

main();
