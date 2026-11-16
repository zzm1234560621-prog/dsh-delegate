#!/usr/bin/env node
'use strict';

/**
 * 继续失败任务的选取逻辑：哪些能继续、哪些要跳过、去重是否生效。
 * 在隔离的 DSH_HOME 里构造记录，不碰真实运行历史。
 *
 *   node test/resume.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sandbox = path.join(os.tmpdir(), `dsh-resume-${Date.now()}`);
const home = path.join(sandbox, 'home');
const runs = path.join(home, 'delegate-runs');
fs.mkdirSync(runs, { recursive: true });
process.env.DSH_HOME = home;

const resume = require(path.join(ROOT, 'lib', 'resume'));

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

let seq = 0;
function writeRun(fields) {
  seq += 1;
  const id = `run-test-${String(seq).padStart(4, '0')}`;
  const meta = {
    id,
    kind: 'task',
    title: fields.title || id,
    cwd: process.cwd(),
    pid: 1,
    startedAt: Date.now() - seq * 1000,
    state: 'failed',
    toolCalls: 0,
    ...fields,
  };
  fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify(meta));
  return id;
}

console.log('\n== 可重试判定 ==');
check('网关超时可以继续', resume.retryable({ state: 'failed', sessionId: 'session-a', reason: 'TIMEOUT: Request timed out.' }));
check('连接重置可以继续', resume.retryable({ state: 'failed', sessionId: 'session-a', reason: 'ECONNRESET' }));
check('写作用域错误不继续', !resume.retryable({ state: 'failed', sessionId: 'session-a', reason: 'write_scope 目录不存在' }));
check('成功的记录不继续', !resume.retryable({ state: 'done', sessionId: 'session-a', reason: '' }));
check('没有 session 不继续', !resume.retryable({ state: 'failed', sessionId: null, reason: 'TIMEOUT' }));

console.log('\n== 选取与去重 ==');
const good = writeRun({ title: '可继续', sessionId: 'session-good', reason: 'TIMEOUT: dsh-opencode-go: Request timed out.' });
const noSession = writeRun({ title: '没有会话', sessionId: null, reason: 'TIMEOUT' });
const done = writeRun({ title: '已完成', state: 'done', sessionId: 'session-done', reason: '' });
const badReason = writeRun({ title: '不可重试', sessionId: 'session-bad', reason: 'task 不能为空' });
const already = writeRun({ title: '已续接过', sessionId: 'session-old', reason: 'TIMEOUT' });
writeRun({ title: '续接记录', kind: 'resume', state: 'running', sessionId: 'session-old', sourceRunId: already, reason: '' });

const picked = resume.pickCandidates({ limit: 10 });
const ids = picked.candidates.map((run) => run.id);
check('只挑可重试的失败', ids.includes(good), ids.join(','));
check('没有 session 的被跳过', !ids.includes(noSession));
check('已完成的被跳过', !ids.includes(done));
check('不可重试的被跳过', !ids.includes(badReason));
check('已续接过的源记录不再挑', !ids.includes(already), ids.join(','));

const limited = resume.pickCandidates({ limit: 1 });
check('limit 生效', limited.candidates.length === 1, String(limited.candidates.length));

const byId = resume.pickCandidates({ ids: [noSession] });
check('按 id 指定时仍做校验', byId.candidates.length === 0 && byId.skipped.length === 1);

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项:');
  for (const item of failures) console.log('  - ' + item);
}
process.exit(fail ? 1 : 0);
