'use strict';
// 补跑清单里还没人动的 3 个（按 session id 续接）。独立进程跑，保持存活直到子任务结束。

const path = require('node:path');
const ROOT = 'C:/Users/zzm12/Documents/deepseek-harness/default-workspace/dsh-delegate';
const resume = require(path.join(ROOT, 'lib', 'resume'));

const common = [
  '继续这个任务，把它补齐到可以交付的完整状态。',
  '要求：',
  '1. 先读现有文件，确认已经写到哪一步、缺哪些小节；',
  '2. 只补缺失部分和结尾两节（"与 v1 / 简报不一致之处""待调研清单"），已经写好的内容不要重写、不要压缩；',
  '3. 不设字数上限，写长一点没关系，不要为了缩短而删内容；',
  '4. 完成后用一段话汇报：补了哪些章节、文件现在多少字、还有什么需要我拿主意。',
].join('\n');

const jobs = [
  {
    sessionId: 'session-a08fc24f-5b93-4d2e-b2ee-9c2d3db194ba',
    title: '补跑：人物志03 周晓雯与牛国庆',
    task: '你之前在写 docs/02_游戏大纲/07_人物志/03_周晓雯与牛国庆.md，约 1.1 万字，还没写结尾。\n\n' + common,
  },
  {
    sessionId: 'session-e5ae4270-ee50-4c5e-a4b2-3aee234bdff6',
    title: '补跑：场景章5 高三上',
    task: '你之前在写 docs/02_游戏大纲/06_主线场景/5_高三上.md，中途断流。\n\n' + common,
  },
  {
    sessionId: 'session-a2dff439-2a2e-488f-86c7-2a47befcc1f2',
    title: '补跑：建模05 宿舍区',
    task: '你之前在写 docs/04_美术/场景建模/05_宿舍区.md，被压缩重写打断，现在只剩约 4800 字，内容不完整。\n\n' + common,
  },
];

const cwd = 'D:/chinese game';

(async () => {
  for (const job of jobs) {
    console.log('[start]', job.title);
    try {
      const result = await resume.resumeOne(
        { id: job.sessionId, title: job.title, cwd, sessionId: job.sessionId, state: 'failed', reason: 'manual' },
        { task: job.task, timeoutMs: 0 },
      );
      console.log('[done]', job.title, result.ok ? 'OK' : 'FAILED', result.reason || '');
    } catch (cause) {
      console.log('[error]', job.title, cause.message);
    }
  }
  console.log('ALL DONE');
})();
