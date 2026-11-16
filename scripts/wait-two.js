'use strict';
// 等待 人物志07 / 场景章6 两个续接任务结束，然后打印最终状态。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sessions = {
  人物志07: 'session-6f1e1cc6-68ab-48c5-9d6e-52533c8ad030',
  场景章6: 'session-e0f0e7dd-ee1d-48af-8ad7-153140a6dcc9',
};
const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'delegate-runs');
const deadline = Date.now() + 45 * 60 * 1000;

function latest(sid) {
  const rows = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((m) => m.sessionId === sid && /^继续|^重跑/.test(m.title || ''))
    .sort((a, b) => b.startedAt - a.startedAt);
  return rows[0] || null;
}

function fileOf(name) {
  return name === '人物志07'
    ? 'D:/chinese game/docs/02_游戏大纲/07_人物志/07_马卫东_林晓雨_许嘉树.md'
    : 'D:/chinese game/docs/02_游戏大纲/06_主线场景/6_高三下.md';
}

(async () => {
  while (Date.now() < deadline) {
    const states = Object.entries(sessions).map(([name, sid]) => {
      const run = latest(sid);
      return { name, run, done: run && run.state !== 'running' };
    });
    if (states.every((s) => s.done)) {
      for (const s of states) {
        const file = fileOf(s.name);
        const size = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
        console.log(`${s.name} | ${s.run.state} | ${Math.round((s.run.durationMs || 0) / 1000)}s | 文件 ${size} 字 | ${s.run.reason || 'ok'}`);
      }
      console.log('ALL DONE');
      return;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  console.log('TIMEOUT waiting for both');
})();
