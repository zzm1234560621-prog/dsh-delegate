#!/usr/bin/env node
'use strict';

/**
 * 回归：同一窗口里，更新的 statusline 快照必须压过旧的「已触顶」记录。
 *
 * 之前的合并逻辑无条件保留触顶记录，于是出现「5h 82%」和「已触顶」同时显示，
 * 提醒还会说额度已经用尽。这里用隔离目录复现两种来源并断言结果。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sandbox = path.join(os.tmpdir(), `dsh-quota-merge-${Date.now()}`);
const projects = path.join(sandbox, 'projects', 'proj');
fs.mkdirSync(projects, { recursive: true });

process.env.DSH_HOME = path.join(sandbox, 'home');
process.env.CLAUDE_PROJECTS_DIR = path.join(sandbox, 'projects');

const quota = require(path.join(ROOT, 'lib', 'quota'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const now = Date.now();
const resetAt = Math.floor(now / 1000) + 3600;

// 新的状态栏快照：5 小时窗口 82%
quota.recordClaude(
  {
    rate_limits: {
      five_hour: { used_percentage: 82, resets_at: resetAt },
      seven_day: { used_percentage: 41 },
    },
  },
  now,
);

// 同一窗口、10 分钟前的一条「已触顶」记录
const line = JSON.stringify({
  type: 'assistant',
  timestamp: new Date(now - 600000).toISOString(),
  message: { content: [{ type: 'text', text: 'x' }] },
  apiError: 'usage_limit_reached',
  quotaLimits: { status: 'rejected', resetsAt: resetAt, rateLimitType: 'five_hour' },
});
const transcript = path.join(projects, 'transcript.jsonl');
fs.writeFileSync(transcript, `${line}\n`);
const old = new Date(now - 600000);
fs.utimesSync(transcript, old, old);

const merged = quota.readClaude(now);
check('更新的快照压过旧的触顶记录', !merged || !merged.limit, merged && merged.limit ? 'limit 仍在' : '');

const summary = quota.summary(now);
check('档位按 82% 判为 high', summary.claude.level === 'high', summary.claude.level);

const advice = quota.advice(merged, 'Claude') || '';
check('提醒里不再说「用尽 / 已触顶」', !/用尽|已触顶/.test(advice), advice.slice(0, 50));
check('提醒里带上了实际百分比', /82/.test(advice), advice.slice(0, 50));

// 反向：没有新快照时，触顶记录仍然有效
quota.recordClaude({ rate_limits: {} }, now);
fs.rmSync(path.join(process.env.DSH_HOME, 'quota'), { recursive: true, force: true });
const limitOnly = quota.readClaudeLimit(now, process.env.CLAUDE_PROJECTS_DIR);
check('没有快照时仍能读到触顶记录', Boolean(limitOnly && limitOnly.type === 'five_hour'));

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  for (const item of failures) console.log('  - ' + item);
}
process.exit(fail ? 1 : 0);
