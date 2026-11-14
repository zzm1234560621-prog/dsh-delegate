#!/usr/bin/env node
'use strict';

/**
 * Edge-case suite: fresh-machine installs (isolated HOME) and protocol errors.
 * Runs offline; it never calls a model.
 *
 *   node test/edge.js
 */

const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-delegate.js');

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

function sandbox(label) {
  const dir = path.join(os.tmpdir(), `dsh-edge-${label}-${Date.now()}`);
  const home = path.join(dir, 'home');
  const user = path.join(dir, 'user');
  const appdata = path.join(dir, 'appdata');
  const local = path.join(dir, 'local');
  for (const d of [home, user, appdata, local]) fs.mkdirSync(d, { recursive: true });
  return { dir, home, user, appdata, local };
}

function envFor(sb) {
  return {
    ...process.env,
    DSH_HOME: sb.home,
    USERPROFILE: sb.user,
    APPDATA: sb.appdata,
    LOCALAPPDATA: sb.local,
    HOME: sb.user,
    // a developer's own CLAUDE_CONFIG_DIR / CODEX_HOME must never be touched by tests
    // (CLAUDE_CONFIG_DIR = the sandbox home keeps the config at <home>/.claude.json)
    CLAUDE_CONFIG_DIR: sb.user,
    CODEX_HOME: path.join(sb.user, '.codex'),
  };
}

function runInstall(sb, args = []) {
  return spawnSync(process.execPath, [CLI, 'install', '--no-clients', ...args], {
    env: envFor(sb),
    encoding: 'utf8',
    timeout: 120000,
  });
}

function runInstallWithClients(sb, args = []) {
  return spawnSync(process.execPath, [CLI, 'install', ...args], {
    env: envFor(sb),
    encoding: 'utf8',
    timeout: 120000,
  });
}

// ---------------------------------------------------------------- installer

console.log('\n== 安装器：全新机器 ==');
{
  const sb = sandbox('fresh');
  const result = runInstallWithClients(sb);
  check('install 退出码 0', result.status === 0, `status=${result.status}`);
  check('bridge 部署存在', fs.existsSync(path.join(sb.home, 'bridge', 'lib', 'mcp.js')));
  check('skill 写入', fs.existsSync(path.join(sb.home, 'skills', 'dsh-delegate', 'SKILL.md')));
  const claude = path.join(sb.local, 'Claude-Data');
  // No Claude Desktop installed in this sandbox: at least one client must be attempted.
  check('输出包含安装结果表', /安装结果/.test(result.stdout || ''));
  console.log(`    （沙箱里没有 Claude Desktop，claude-desktop 目标应为 skipped）`);
  check('没有把无关文件写进 user 目录', !fs.existsSync(path.join(sb.user, 'not-a-real-file')));
}

console.log('\n== 安装器：claude_desktop_config.json 损坏 ==');
{
  const sb = sandbox('corrupt-desktop');
  const claudeDir = path.join(sb.local, 'Claude-Data', 'claude_test');
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'claude_desktop_config.json');
  fs.writeFileSync(file, '{ this is not json');
  const result = runInstallWithClients(sb);
  const intact = fs.readFileSync(file, 'utf8') === '{ this is not json';
  check('坏配置不会让安装崩溃', result.status === 0, `status=${result.status}`);
  check('坏配置保持不变（未被覆盖）', intact);
  check('输出里有明确状态', /claude-desktop/.test(result.stdout || ''));
}

console.log('\n== 安装器：~/.claude.json 损坏 ==');
{
  const sb = sandbox('corrupt-code');
  const file = path.join(sb.user, '.claude.json');
  fs.writeFileSync(file, '{ broken json');
  const result = runInstallWithClients(sb);
  const after = fs.readFileSync(file, 'utf8');
  const overwritten = !after.includes('broken json');
  check('安装不崩溃', result.status === 0, `status=${result.status}`);
  check('损坏的 ~/.claude.json 不被静默覆盖', !overwritten, overwritten ? '内容被替换，用户数据丢失' : '');
}

console.log('\n== 安装器：DSH 不可用 ==');
{
  const sb = sandbox('nodsh');
  const result = spawnSync(process.execPath, [CLI, 'install', '--dry-run'], {
    env: { ...envFor(sb), DSH_DELEGATE_APP: path.join(sb.dir, 'nope.exe') },
    encoding: 'utf8',
    timeout: 60000,
  });
  check('给出可读错误', /DSH|找不到/.test((result.stderr || '') + (result.stdout || '')));
  check('退出码非 0', result.status !== 0);
}

console.log('\n== 安装器：重复安装（幂等） ==');
{
  const sb = sandbox('idempotent');
  const first = runInstallWithClients(sb);
  const second = runInstallWithClients(sb);
  check('两次都成功', first.status === 0 && second.status === 0);
  const skill = path.join(sb.home, 'skills', 'dsh-delegate', 'SKILL.md');
  check('skill 未被重复追加', fs.readFileSync(skill, 'utf8').split('dsh-delegate').length < 10);
  const agents = fs.readFileSync(path.join(sb.home, 'AGENTS.md'), 'utf8');
  check('AGENTS.md 只有一个标记块', (agents.match(/dsh-delegate:start/g) || []).length === 1);
}

// ---------------------------------------------------------------- protocol

console.log('\n== MCP 协议边界 ==');
const SERVER = path.join(ROOT, 'lib', 'mcp.js');

async function withServer(fn) {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch {
          /* server wrote a non-JSON line */
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  let seq = 0;
  const send = (method, params) => {
    const id = (seq += 1);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'edge', version: '1' } });
    await fn({ send, child });
  } finally {
    child.kill();
  }
}

(async () => {
  await withServer(async ({ send, child }) => {
    const list = await send('tools/list', {});
    check('tools/list 返回 3 个工具', (list.result?.tools || []).length === 3);

    const unknown = await send('tools/call', { name: 'no_such_tool', arguments: {} });
    check('未知工具返回错误文本', Boolean(unknown.result?.isError));

    const empty = await send('tools/call', { name: 'dsh_parallel', arguments: { tasks: [] } });
    check('空 tasks 被拒绝', Boolean(empty.result?.isError));

    const badScope = await send('tools/call', {
      name: 'dsh_task',
      arguments: { task: 'x', write_scope: '../outside' },
    });
    check('越界 write_scope 被拒绝', Boolean(badScope.result?.isError));

    const missingScope = await send('tools/call', {
      name: 'dsh_task',
      arguments: { task: 'x', write_scope: 'no-such-dir' },
    });
    check('不存在的 write_scope 被拒绝', Boolean(missingScope.result?.isError));

    const emptyTask = await send('tools/call', { name: 'dsh_task', arguments: { task: '   ' } });
    check('空 task 被拒绝', Boolean(emptyTask.result?.isError));

    const badJob = await send('tools/call', { name: 'dsh_job', arguments: { job_id: 'dsh-nope' } });
    check('未知 job_id 返回错误', Boolean(badJob.result?.isError));

    const unknownMethod = await send('no/such/method', {});
    check('未知方法返回 -32601', unknownMethod.error?.code === -32601);

    // Garbage line must not kill the server.
    child.stdin.write('{not json}\n');
    const ping = await send('ping', {});
    check('垃圾输入后仍可 ping', Boolean(ping.result));
  });

  // ---- 追加：更多故障注入
  console.log('\n== 极端输入 ==');
  await withServer(async ({ send, child }) => {
    // 1. 100KB 的任务文本
    const big = await send('tools/call', {
      name: 'dsh_task',
      arguments: { task: 'x'.repeat(100 * 1024), write_scope: 'still-not-a-dir' },
    });
    check('超大任务不崩服务（返回结构化错误）', Boolean(big.result));

    // 2. write_scope 指向文件而不是目录
    const fileScope = require('node:path').join(require('node:os').tmpdir(), 'dsh-edge-file.txt');
    require('node:fs').writeFileSync(fileScope, 'x');
    const res = await send('tools/call', {
      name: 'dsh_task',
      arguments: { task: 'x', write_scope: fileScope },
    });
    check('write_scope 指向文件被拒绝', Boolean(res.result?.isError));
    require('node:fs').rmSync(fileScope, { force: true });

    // 3. 并发两次 tools/call（不等待第一个）
    const p1 = send('tools/call', { name: 'dsh_task', arguments: { task: '   ' } });
    const p2 = send('tools/call', { name: 'dsh_task', arguments: { task: '   ' } });
    const [r1, r2] = await Promise.all([p1, p2]);
    check('并发请求各自得到响应', Boolean(r1.result && r2.result));

    // 4. notifications（无 id）不产生响应也不崩
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const pong = await send('ping', {});
    check('通知类消息不影响后续响应', Boolean(pong.result));
  });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  if (failures.length) {
    console.log('\n失败项:');
    for (const item of failures) console.log('  - ' + item);
  }
  process.exit(fail ? 1 : 0);
})();
