#!/usr/bin/env node
// 解析 commit message 中的 [roadmap:TASK_ID-done] 标记，自动更新 roadmap.json
// 用法：node scripts/sync-roadmap.js "commit message"

const fs = require('fs');
const path = require('path');

const msg = process.argv[2] || '';
const matches = [...msg.matchAll(/\[roadmap:([^\]]+)-done\]/g)];
if (!matches.length) process.exit(0);

const roadmapPath = path.resolve(__dirname, '../roadmap/roadmap.json');
const roadmap = JSON.parse(fs.readFileSync(roadmapPath, 'utf8'));

const today = new Date().toISOString().replace('T', ' ').slice(0, 19) + '+08:00';
let changed = false;

for (const [, taskId] of matches) {
  for (const phase of roadmap.phases) {
    const task = phase.tasks?.find(t => t.id === taskId);
    if (task && task.status !== 'completed') {
      task.status = 'completed';
      task.completedDate = today.slice(0, 10);
      console.log(`已标记任务 ${taskId} 为 completed`);
      changed = true;
    }
  }
}

if (changed) {
  roadmap.meta.lastUpdated = today;
  fs.writeFileSync(roadmapPath, JSON.stringify(roadmap, null, 2));
  console.log('roadmap.json 已更新');
}
