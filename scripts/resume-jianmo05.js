'use strict';
// 建模05：用会话自己的目录续接（之前用仓库根目录被 DSH 拒绝）。
const path = require('node:path');
const ROOT = 'C:/Users/zzm12/Documents/deepseek-harness/default-workspace/dsh-delegate';
const resume = require(path.join(ROOT, 'lib', 'resume'));

const sessionId = 'session-a2dff439-2a2e-488f-86c7-2a47befcc1f2';
const task = [
  '你之前在写 05_宿舍区.md，被压缩重写打断，现在只剩约 4800 字，内容不完整。',
  '',
  '继续这个任务，把它补齐到可以交付的完整状态：',
  '1. 先读现有文件，确认写到哪一步、缺哪些小节；',
  '2. 补齐缺失部分和结尾两节（"与 v1 / 简报不一致之处""待调研清单"），已写好的不要重写、不要压缩；',
  '3. 不设字数上限；',
  '4. 优先用免费来源（必应 RSS / 官网 / 直接抓网页），web_search 只作补充；',
  '5. 完成后汇报：补了哪些章节、文件现在多少字。',
].join('\n');

(async () => {
  const cwd = resume.sessionCwd(sessionId);
  console.log('[cwd]', cwd);
  const result = await resume.resumeOne(
    { id: sessionId, title: '重跑：建模05 宿舍区', cwd, sessionId, state: 'failed', reason: 'manual' },
    { task, timeoutMs: 0 },
  );
  console.log('[done]', result.ok ? 'OK' : 'FAILED', result.reason || '');
  console.log('ALL DONE');
})();
