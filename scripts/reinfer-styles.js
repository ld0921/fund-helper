#!/usr/bin/env node
// 基于现有 topStocks 数据和最新的 stock-industry-map.json
// 重新计算精选库所有基金的 style 字段（风格归因）
// 用途：风格分散度功能上线时，无需重新拉取数据即可生效

const fs = require('fs');
const path = require('path');

const INDUSTRY_STYLE = {
  // Growth 成长
  '通信设备': 'growth', '通信服务': 'growth', '元件': 'growth',
  '半导体': 'growth', '光学光电子': 'growth', '消费电子': 'growth',
  '计算机设备': 'growth', '其他电子Ⅱ': 'growth',
  '软件开发': 'growth', 'IT服务Ⅱ': 'growth', '互联网服务': 'growth',
  '化学制药': 'growth', '生物制品': 'growth', '医疗器械': 'growth', '医疗服务': 'growth',
  '电池': 'growth', '光伏设备': 'growth', '风电设备': 'growth',
  '电网设备': 'growth', '电机Ⅱ': 'growth', '其他电源设备Ⅱ': 'growth',
  '军工电子Ⅱ': 'growth', '航空装备Ⅱ': 'growth', '航天装备Ⅱ': 'growth',
  '地面兵装Ⅱ': 'growth', '航海装备Ⅱ': 'growth',
  '自动化设备': 'growth', '专用设备': 'growth',
  '汽车零部件': 'growth',
  // Value 价值
  '股份制银行Ⅱ': 'value', '城商行Ⅱ': 'value', '国有大型银行Ⅱ': 'value',
  '农商行Ⅱ': 'value', '证券Ⅱ': 'value', '保险Ⅱ': 'value', '多元金融': 'value',
  '工业金属': 'value', '钢铁': 'value', '小金属': 'value', '贵金属': 'value',
  '化学原料': 'value', '化学纤维': 'value', '橡胶': 'value', '塑料': 'value',
  '房地产开发': 'value', '基础建设': 'value', '专业工程': 'value',
  '装修建材': 'value', '水泥': 'value', '玻璃玻纤': 'value',
  '物流': 'value', '航运港口': 'value', '铁路公路': 'value',
  // Dividend 红利
  '煤炭开采': 'dividend', '石油开采': 'dividend', '油气开采Ⅱ': 'dividend',
  '电力': 'dividend', '燃气Ⅱ': 'dividend',
  // Blend 混合
  '白酒Ⅱ': 'blend', '食品加工': 'blend', '饮料乳品': 'blend',
  '调味发酵品Ⅱ': 'blend', '休闲食品': 'blend',
  '中药Ⅱ': 'blend', '医药商业': 'blend',
  '家居用品': 'blend', '服装家纺': 'blend', '化妆品': 'blend',
  '白色家电': 'blend', '黑色家电': 'blend', '厨卫电器': 'blend', '小家电': 'blend',
  '汽车整车': 'blend', '商用车': 'blend', '乘用车': 'blend', '汽车服务': 'blend',
  '环境治理': 'blend', '通用设备': 'blend',
};

function inferFundStyle(topStocks, stockMap) {
  if (!topStocks || topStocks.length === 0) return null;
  const styleWeight = { growth: 0, value: 0, dividend: 0, blend: 0 };
  let mappedTotal = 0;
  topStocks.forEach(s => {
    const entry = stockMap[s.code];
    if (entry && entry.industry) {
      const style = INDUSTRY_STYLE[entry.industry];
      if (style) {
        styleWeight[style] += s.pct;
        mappedTotal += s.pct;
      }
    }
  });
  if (mappedTotal < 10) return null;
  const sorted = Object.entries(styleWeight).sort((a, b) => b[1] - a[1]);
  const [topStyle, topWeight] = sorted[0];
  const distribution = {
    growth: Math.round(styleWeight.growth / mappedTotal * 100),
    value: Math.round(styleWeight.value / mappedTotal * 100),
    dividend: Math.round(styleWeight.dividend / mappedTotal * 100),
    blend: Math.round(styleWeight.blend / mappedTotal * 100),
  };
  return { style: topWeight / mappedTotal > 0.40 ? topStyle : 'blend', distribution };
}

// 兜底归因：基金名称匹配（用于 QDII / 重仓股缺失的情况）
function fallbackStyle(entry) {
  const name = entry.name || '';
  if (entry.cat === 'qdii') {
    return /红利|股息|价值/.test(name) ? 'dividend' : 'growth';
  }
  if (entry.cat === 'money') return 'cash';
  if (entry.cat === 'bond') return 'bond';
  if (entry.cat === 'index') {
    if (/红利|股息|低波|高股息/.test(name)) return 'dividend';
    if (/价值|沪深300价值|基本面|银行|金融|煤炭|地产/.test(name)) return 'value';
    if (/通信|半导体|芯片|科技|人工智能|AI|信息|互联网|新能源|医药|医疗|生物|军工|创业板/.test(name)) return 'growth';
    if (/沪深300|上证50|中证100|大盘/.test(name)) return 'blend';
    return 'blend';
  }
  if (entry.cat === 'active') {
    if (/红利|股息|价值/.test(name)) return 'value';
    return 'blend';
  }
  return null;
}

function main() {
  const curatedPath = path.join(__dirname, '..', 'data', 'curated-details.json');
  const mapPath = path.join(__dirname, '..', 'data', 'stock-industry-map.json');

  const curated = JSON.parse(fs.readFileSync(curatedPath, 'utf-8'));
  const stockMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8')).stocks;

  let stockBased = 0, nameBased = 0, distribution = { growth: 0, value: 0, dividend: 0, blend: 0, cash: 0, bond: 0 };
  Object.values(curated.funds).forEach(f => {
    let result = null;
    if (f.topStocks && f.topStocks.length > 0) {
      result = inferFundStyle(f.topStocks, stockMap);
      if (result) {
        f.style = result.style;
        f.styleDistribution = result.distribution;
        f.styleSource = 'topStocks';
        stockBased++;
      }
    }
    if (!f.style) {
      const fb = fallbackStyle(f);
      if (fb) {
        f.style = fb;
        f.styleSource = 'name';
        nameBased++;
      }
    }
    if (f.style && distribution[f.style] !== undefined) distribution[f.style]++;
  });

  fs.writeFileSync(curatedPath, JSON.stringify(curated, null, 2), 'utf-8');
  console.log(`完成: 基于重仓股归因 ${stockBased} 只，基于名称归因 ${nameBased} 只`);
  console.log('风格分布:');
  Object.entries(distribution).forEach(([s, c]) => console.log(`  ${s}: ${c} 只`));
}

main();
