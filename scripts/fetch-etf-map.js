#!/usr/bin/env node
// feeder-etf-map.json 是手工维护的静态映射，不支持自动发现
// 本脚本仅打印当前映射，供手动新增联接基金时参考
// 添加新联接基金时：手动在 data/feeder-etf-map.json 中添加 {"feederCode": "etfCode"} 即可

const fs   = require('fs');
const path = require('path');

const mapPath = path.join(__dirname, '..', 'data', 'feeder-etf-map.json');
const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
console.log(`feeder-etf-map.json: ${Object.keys(map).length} 条映射`);
Object.entries(map).forEach(([feeder, etf]) => console.log(`  ${feeder} → ${etf}`));
