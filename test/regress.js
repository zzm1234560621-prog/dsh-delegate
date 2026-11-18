#!/usr/bin/env node
'use strict';

/**
 * Regression suite for defects found in review. Offline: DSH is replaced by
 * test/fixtures/fake-dsh.js, every client config lives in a throwaway sandbox.
 *
 *   node test/regress.js
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-delegate.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-dsh.js');
const NODE = process.execPath;
const WIN = process.platform === 'win32';
const SYS = WIN ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];

let pass = 0;
const failures = [];
const sandboxes = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sandbox(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-regress-${label}-`));
  sandboxes.push(dir);
  const sb = { dir };
  for (const key of ['home', 'user', 'appdata', 'local', 'programs']) {
    sb[key] = path.join(dir, key);
    fs.mkdirSync(sb[key], { recursive: true });
  }
  return sb;
}

/** Fresh-machine env: no real DSH, no real client, PATH limited to node + system. */
function envFor(sb, extra = {}) {
  return {
    ...process.env,
    DSH_HOME: sb.home,
    USERPROFILE: sb.user,
    HOME: sb.user,
    APPDATA: sb.appdata,
    LOCALAPPDATA: sb.local,
    ProgramFiles: sb.programs,
    'ProgramFiles(x86)': sb.programs,
    ProgramW6432: sb.programs,
    CLAUDE_CONFIG_DIR: sb.user,
    CODEX_HOME: path.join(sb.user, '.codex'),
    DSH_DELEGATE_APP: '',
    DSH_DELEGATE_BOOTSTRAP: '',
    PATH: [path.dirname(NODE), ...SYS].join(path.delimiter),
    ...extra,
  };
}

/** The env that makes discover() treat node + fake-dsh.js as the desktop app. */
const FAKE_DESKTOP = { DSH_DELEGATE_APP: NODE, DSH_DELEGATE_BOOTSTRAP: FAKE };

function cli(sb, args, extra) {
  return spawnSync(NODE, [CLI, ...args], { env: envFor(sb, extra), encoding: 'utf8', timeout: 120_000 });
}

function nodeEval(sb, code, extra) {
  return spawnSync(NODE, ['-e', code], { env: envFor(sb, extra), encoding: 'utf8', timeout: 60_000 });
}

const req = (file) => JSON.stringify(path.join(ROOT, 'lib', file));

// ---------------------------------------------------------------- launcher

console.log('\n== 启动器：不覆盖、不删除别人的 dsh ==');
{
  const sb = sandbox('launcher');
  const dir = WIN ? path.join(sb.appdata, 'npm') : path.join(sb.user, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, WIN ? 'dsh.cmd' : 'dsh');
  const original = WIN ? `@echo off\r\n"${NODE}" "${FAKE}" %*\r\n` : `#!/bin/sh\nexec "${NODE}" "${FAKE}" "$@"\n`;
  fs.writeFileSync(file, original);
  if (!WIN) fs.chmodSync(file, 0o755);
  const withCli = { PATH: [dir, path.dirname(NODE), ...SYS].join(path.delimiter) };

  const install = cli(sb, ['install', '--no-clients'], withCli);
  check('PATH 上已有 dsh（npm 版）时安装成功', install.status === 0, install.stderr);
  check('已有的 dsh 未被覆盖', fs.readFileSync(file, 'utf8') === original);
  cli(sb, ['uninstall'], withCli);
  check('卸载不删除别人的 dsh', fs.existsSync(file) && fs.readFileSync(file, 'utf8') === original);

  const desktopInstall = cli(sb, ['install', '--no-clients'], FAKE_DESKTOP);
  check('桌面版 + 目标位置有别人的 dsh：仍不覆盖', desktopInstall.status === 0 && fs.readFileSync(file, 'utf8') === original);

  fs.rmSync(file);
  cli(sb, ['install', '--no-clients'], FAKE_DESKTOP);
  const generated = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check('只有桌面版时生成启动器', generated.includes('dsh-delegate shim'));
  check('启动器带上 bootstrap（--dsh-app 不再传空参数）', generated.includes(path.basename(FAKE)));
  // README runs uninstall from the deployed copy, which --remove-runtime deletes.
  const deployed = path.join(sb.home, 'bridge', 'bin', 'dsh-delegate.js');
  const uninstall = spawnSync(NODE, [deployed, 'uninstall', '--remove-runtime'], {
    env: envFor(sb, FAKE_DESKTOP),
    encoding: 'utf8',
    timeout: 60_000,
  });
  check('从 bridge 自身运行 uninstall --remove-runtime 正常退出', uninstall.status === 0, uninstall.stderr.trim());
  check('卸载删除自己生成的启动器和运行时', !fs.existsSync(file) && !fs.existsSync(path.join(sb.home, 'bridge')));
}

if (WIN) {
  console.log('\n== Windows：.cmd 启动器与带空格的路径 ==');
  const sb = sandbox('spaces');
  const dir = path.join(sb.dir, 'app data', 'npm');
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'dsh.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${NODE}" "${FAKE}" %*\r\n`);
  const out = nodeEval(
    sb,
    `require(${req('dsh.js')}).runTask({task:'hi', cwd:${JSON.stringify(sb.dir)},` +
      `launch:{kind:'cli',command:${JSON.stringify(shim)},argsPrefix:[]}}).then(r=>console.log(JSON.stringify(r)))`,
  );
  let result = {};
  try {
    result = JSON.parse(out.stdout.trim().split('\n').pop());
  } catch {
    result = { reason: out.stdout + out.stderr };
  }
  check('路径带空格的 dsh.cmd 能启动', result.ok === true, result.reason || result.stderrTail);

  const bin = path.join(sb.dir, 'fake bin');
  fs.mkdirSync(bin);
  const log = path.join(sb.dir, 'claude-args.log');
  fs.writeFileSync(
    path.join(bin, 'rec.js'),
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
  );
  fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\n"${NODE}" "%~dp0rec.js" %*\r\n`);
  nodeEval(
    sb,
    `require(${req('targets.js')}).applyAll(['claude-code'],` +
      `{nodePath:'C:\\\\Program Files\\\\nodejs\\\\node.exe',mcpPath:'C:\\\\a b\\\\mcp.js',dshHome:'C:\\\\h'},{dryRun:false})`,
    { PATH: [bin, path.dirname(NODE), ...SYS].join(path.delimiter) },
  );
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  const add = calls.find((call) => call[1] === 'add') || [];
  check(
    'claude.cmd 收到完整的 node / mcp.js 路径',
    add.includes('C:\\Program Files\\nodejs\\node.exe') && add.includes('C:\\a b\\mcp.js'),
    JSON.stringify(add),
  );

  console.log('\n== Windows：install.cmd 的两种参数写法 ==');
  const sbi = sandbox('installcmd');
  const ps = path.join(SYS[0], 'WindowsPowerShell', 'v1.0');
  const env = envFor(sbi, { ...FAKE_DESKTOP, PATH: [path.dirname(NODE), ...SYS, ps].join(path.delimiter) });
  const installCmd = (...flags) =>
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', path.join(ROOT, 'install.cmd'), ...flags], {
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  for (const flag of ['--dry-run', '-DryRun']) {
    const run = installCmd(flag);
    const wrote = fs.existsSync(path.join(sbi.home, 'bridge'));
    check(`install.cmd ${flag} 只预览不写入`, run.status === 0 && !wrote && /dry-run/.test(run.stdout), `exit ${run.status} ${run.stderr.trim().slice(0, 200)}`);
  }
  const picked = installCmd('--dry-run', '--targets=claude-code,codex');
  check(
    'install.cmd --targets=a,b 原样传到安装器',
    picked.status === 0 && /client:codex/.test(picked.stdout) && !/client:claude-desktop/.test(picked.stdout),
    `exit ${picked.status} ${picked.stderr.trim().slice(0, 200)}`,
  );
}

console.log('\n== 安装器：拼错的参数不会真的安装 ==');
{
  const sb = sandbox('typo');
  const run = cli(sb, ['install', '--dryrun'], FAKE_DESKTOP);
  check('install --dryrun 被拒绝', run.status !== 0 && /不认识/.test(run.stderr), run.stderr.trim());
  check('拒绝时没有写入任何东西', !fs.existsSync(path.join(sb.home, 'bridge')));
  const positional = cli(sb, ['install', '-DryRun'], FAKE_DESKTOP);
  check('install -DryRun（单横线）也被拒绝', positional.status !== 0);
}

// ---------------------------------------------------------------- client wiring

console.log('\n== 客户端配置：幂等，不反复备份 ==');
{
  const sb = sandbox('idempotent');
  const desktopDir = WIN
    ? path.join(sb.local, 'Claude-Data', 'claude_test')
    : process.platform === 'darwin'
      ? path.join(sb.user, 'Library', 'Application Support', 'Claude')
      : path.join(sb.user, '.config', 'Claude');
  fs.mkdirSync(desktopDir, { recursive: true });
  const desktopFile = path.join(desktopDir, 'claude_desktop_config.json');
  fs.writeFileSync(desktopFile, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const apply = `require(${req('targets.js')}).applyAll(['claude-desktop','claude-code','codex'],` +
    `{nodePath:'/n/node',mcpPath:'/b/lib/mcp.js',dshHome:'/h'},{dryRun:false})`;
  for (let i = 0; i < 3; i += 1) nodeEval(sb, `console.log(JSON.stringify(${apply}))`);
  const backups = (dir) => fs.readdirSync(dir).filter((name) => name.includes('.bak-dsh-delegate-')).length;
  check('Claude 桌面版：3 次接线只备份 1 次', backups(desktopDir) === 1, `${backups(desktopDir)} 个备份`);
  check('Claude 桌面版：保留别的 MCP 服务', Boolean(JSON.parse(fs.readFileSync(desktopFile, 'utf8')).mcpServers.other));
  const third = nodeEval(sb, `console.log(JSON.stringify(${apply}))`);
  const statuses = JSON.parse(third.stdout).map((item) => `${item.target}:${item.status}`);
  check('第 4 次全部 unchanged', statuses.every((s) => s.endsWith(':unchanged')), statuses.join(' '));

  // Codex: a stale block we wrote is refreshed in place; a hand-edited one is left alone.
  const codex = path.join(sb.user, '.codex', 'config.toml');
  fs.writeFileSync(codex, 'model = "x"\n\n[mcp_servers.dsh]\ncommand = "/old/node"\nargs = ["/old/lib/mcp.js"]\n\n[other]\na = 1\n');
  nodeEval(sb, apply);
  const refreshed = fs.readFileSync(codex, 'utf8');
  check('Codex：过期的条目原地更新', refreshed.includes('command = "/n/node"') && !refreshed.includes('/old/node'));
  check('Codex：只有一个 [mcp_servers.dsh]', (refreshed.match(/\[mcp_servers\.dsh\]/g) || []).length === 1);
  check('Codex：其它表保持不变', refreshed.includes('[other]\na = 1') && refreshed.startsWith('model = "x"'));
  fs.writeFileSync(codex, '[mcp_servers.dsh]\ncommand = "/mine"\nargs = []\nstartup_timeout_ms = 5\n');
  nodeEval(sb, apply);
  check('Codex：用户自定义的条目不动', fs.readFileSync(codex, 'utf8').includes('command = "/mine"'));

  // Uninstall removes our entries only.
  const desktop = JSON.parse(fs.readFileSync(desktopFile, 'utf8'));
  desktop.mcpServers.dsh = { command: 'python', args: ['their-own-server.py'] };
  fs.writeFileSync(desktopFile, JSON.stringify(desktop));
  nodeEval(sb, `require(${req('targets.js')}).removeAll()`);
  check('卸载：不删别人叫 dsh 的服务', JSON.parse(fs.readFileSync(desktopFile, 'utf8')).mcpServers.dsh.command === 'python');
  nodeEval(sb, apply);
  nodeEval(sb, `require(${req('targets.js')}).removeAll()`);
  const afterRemove = JSON.parse(fs.readFileSync(desktopFile, 'utf8')).mcpServers;
  check('卸载：删除自己的 dsh 条目', !afterRemove.dsh && Boolean(afterRemove.other));
  const claudeJson = JSON.parse(fs.readFileSync(path.join(sb.user, '.claude.json'), 'utf8'));
  check('卸载：Claude Code 条目也移除', !(claudeJson.mcpServers && claudeJson.mcpServers.dsh));
}

// ---------------------------------------------------------------- local HTTP service

function request(base, method, pathname, headers = {}, body) {
  return new Promise((resolve) => {
    const url = new URL(pathname, base);
    const r = http.request({ host: url.hostname, port: url.port, path: url.pathname, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    r.on('error', (error) => resolve({ status: 0, headers: {}, body: error.message }));
    r.end(body);
  });
}

async function httpSuite() {
  console.log('\n== 本地服务：只对本机页面开放 ==');
  const sb = sandbox('http');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(NODE, ['-e', `require(${req('ui.js')}).start({port:${port}}).then(s=>console.log('READY '+s.url))`], {
    env: envFor(sb),
  });
  const base = await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/READY (\S+)/);
      if (match) resolve(match[1]);
    });
    setTimeout(() => resolve(null), 10_000);
  });
  if (!base) {
    check('服务启动', false);
    child.kill();
    return;
  }
  const settingsFile = path.join(sb.home, 'delegate.json');
  const evil = { origin: 'https://evil.example' };

  const read = await request(base, 'GET', '/api/state', evil);
  check('外站读取 /api/state → 403', read.status === 403 && !read.headers['access-control-allow-origin'], `${read.status}`);
  const write = await request(base, 'POST', '/api/settings', { ...evil, 'content-type': 'text/plain' }, '{"permissionMode":"danger-full-access"}');
  check('外站 POST 改设置 → 403', write.status === 403, `${write.status}`);
  check('设置没有被改', !fs.existsSync(settingsFile) || !/danger-full-access/.test(fs.readFileSync(settingsFile, 'utf8')));
  const opaque = await request(base, 'POST', '/api/test', { origin: 'null', 'content-type': 'application/json' }, '{}');
  check('Origin: null（沙箱 iframe 等）→ 403', opaque.status === 403, `${opaque.status}`);
  const rebind = await request(base, 'GET', '/api/state', { host: `attacker.example:${port}` });
  check('DNS rebinding（Host 非本机）→ 403', rebind.status === 403, `${rebind.status}`);

  const dshUi = 'http://127.0.0.1:63813';
  const panel = await request(base, 'GET', '/api/runs', { origin: dshUi });
  check('本机页面（DSH web UI）可读，CORS 回显该来源', panel.status === 200 && panel.headers['access-control-allow-origin'] === dshUi, `${panel.status} ${panel.headers['access-control-allow-origin']}`);
  // The DSH desktop app's panel really sends this origin (seen on a live install).
  const desktopPanel = await request(base, 'GET', '/api/service', { origin: 'dsh-app://app' });
  check('DSH 桌面版面板（dsh-app://app）可读', desktopPanel.status === 200 && desktopPanel.headers['access-control-allow-origin'] === 'dsh-app://app', `${desktopPanel.status} ${desktopPanel.headers['access-control-allow-origin']}`);
  const lookalike = await request(base, 'GET', '/api/state', { origin: 'https://dsh-app.evil.example' });
  check('长得像的外站来源仍 403', lookalike.status === 403, `${lookalike.status}`);
  const local = await request(base, 'GET', '/api/state');
  check('无 Origin（本机脚本）可读，且不带 CORS 头', local.status === 200 && !local.headers['access-control-allow-origin']);
  const plain = await request(base, 'POST', '/api/settings', { 'content-type': 'text/plain' }, '{"softWaitMs":1000}');
  check('非 JSON 请求体 → 415', plain.status === 415, `${plain.status}`);
  const ok = await request(base, 'POST', '/api/settings', { origin: base, 'content-type': 'application/json' }, '{"softWaitMs":1234}');
  check('看板自己的 JSON POST 正常', ok.status === 200 && /1234/.test(fs.readFileSync(settingsFile, 'utf8')), `${ok.status}`);
  const quotaReply = await request(base, 'GET', '/api/quota');
  let quotaBody = {};
  try {
    quotaBody = JSON.parse(quotaReply.body);
  } catch {
    quotaBody = {};
  }
  check('/api/quota 返回 Claude / Codex 额度和阈值', quotaReply.status === 200 && 'claude' in quotaBody && 'codex' in quotaBody && quotaBody.thresholds, `${quotaReply.status}`);
  const smuggle = await request(base, 'POST', '/api/env', { 'content-type': 'application/json' }, JSON.stringify({ name: 'FOO', value: 'x\nDSH_EVIL=1' }));
  const envText = fs.existsSync(path.join(sb.home, '.env')) ? fs.readFileSync(path.join(sb.home, '.env'), 'utf8') : '';
  check('.env 值里的换行被拒绝', smuggle.status === 400 && !/DSH_EVIL/.test(envText), `${smuggle.status}`);
  child.kill();
}

// ---------------------------------------------------------------- MCP jobs

/** lib/mcp.js with fake DSH in `sb`, plus a minimal JSON-RPC client for it. */
function mcpServer(sb) {
  const child = spawn(NODE, [path.join(ROOT, 'lib', 'mcp.js')], { env: envFor(sb, FAKE_DESKTOP) });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let buffer = '';
  const pending = new Map();
  const notes = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        } else if (message.method) {
          notes.push({ at: Date.now(), message });
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  let seq = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = (seq += 1);
      pending.set(id, (message) => resolve({ ...message, at: Date.now() }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = (name, args, meta) => send('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const init = () => send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'regress', version: '1' } });
  return { child, exited, notes, send, call, init };
}

const replyText = (reply) => reply.result.content[0].text;
const jobOf = (reply) => (replyText(reply).match(/job=(dsh-[\w-]+)/) || [])[1];

async function mcpSuite() {
  console.log('\n== MCP：取消只影响自己的作业；进度通知不越过响应 ==');
  const sb = sandbox('mcp');
  const { child, notes, call, init: initialize } = mcpServer(sb);
  const text = replyText;

  const init = await initialize();
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  check('serverInfo 版本与 package.json 一致', init.result && init.result.serverInfo.version === shipped, `${init.result && init.result.serverInfo.version} vs ${shipped}`);
  const echoed = await call('dsh_task', { task: 'ECHO_TASK 看看收到什么', cwd: sb.dir });
  check('派出去的任务开头告诉子代理不要再往下派', /不要再调用 dsh/.test(text(echoed)), text(echoed).split('\n').slice(1, 2).join(''));

  const inline = await call('dsh_task', { task: 'hi', cwd: sb.dir });
  check('dsh_task 直接返回结果（假 DSH）', /DSH ok/.test(text(inline)), text(inline).split('\n')[0]);

  const forever = await call('dsh_task', { task: 'SLEEP=1500 x', cwd: sb.dir, soft_wait_ms: 0 });
  check('soft_wait_ms: 0 一直等到结束', /DSH ok/.test(text(forever)), text(forever).split('\n')[0]);

  const a = await call('dsh_task', { task: 'SLEEP=4000 a', cwd: sb.dir, mode: 'async' }, { progressToken: 'tok-a' });
  const answeredA = a.at;
  const b = await call('dsh_task', { task: 'SLEEP=4000 b', cwd: sb.dir, mode: 'async' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const cancel = await call('dsh_job', { job_id: jobOf(a), action: 'cancel' });
  check('取消作业 A', /已取消/.test(text(cancel)), text(cancel));
  const doneB = await call('dsh_job', { job_id: jobOf(b), wait_ms: 15_000 });
  check('取消 A 不影响 B', /DSH ok/.test(text(doneB)), text(doneB).split('\n')[0]);
  const pollA = await call('dsh_job', { job_id: jobOf(a) });
  check('A 之后查询仍显示已取消', /已取消/.test(text(pollA)), text(pollA).split('\n')[0]);
  const late = notes.filter((n) => n.message.params && n.message.params.progressToken === 'tok-a' && n.at > answeredA);
  check('async 返回后不再用它的 progressToken', late.length === 0, `${late.length} 条越界通知`);

  const c = await call('dsh_task', { task: 'SLEEP=2500 c', cwd: sb.dir, mode: 'async' });
  const waited = await call('dsh_job', { job_id: jobOf(c), wait_ms: 15_000 }, { progressToken: 'tok-poll' });
  const during = notes.filter((n) => n.message.params && n.message.params.progressToken === 'tok-poll');
  check('dsh_job 等待期间用它自己的 token 发进度', during.length > 0 && during.every((n) => n.at <= waited.at), `${during.length} 条`);

  child.kill();
}

async function jobRecoverySuite() {
  console.log('\n== MCP：服务重启后 dsh_job 照样能查；退出时标记中断；单次等待封顶 ==');
  const sb = sandbox('recover');
  const runsDir = path.join(sb.home, 'delegate-runs');
  const recordsOf = (jobId) =>
    (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [])
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')))
      .filter((meta) => meta.jobId === jobId);
  const until = async (predicate, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return predicate();
  };
  const firstLine = (reply) => replyText(reply).split('\n')[0];

  // Finished jobs: the host reconnects (closes stdin), a new server process answers.
  const first = mcpServer(sb);
  await first.init();
  const single = jobOf(await first.call('dsh_task', { task: 'SLEEP=200 single', cwd: sb.dir, mode: 'async' }));
  const batch = jobOf(
    await first.call('dsh_parallel', { tasks: [{ title: '甲', task: 'SLEEP=200 one' }, { title: '乙', task: 'two' }], cwd: sb.dir, mode: 'async' }),
  );
  const settled = (jobId, count) => {
    const records = recordsOf(jobId);
    return records.length === count && records.every((meta) => meta.state === 'done');
  };
  await until(() => settled(single, 1) && settled(batch, 2));
  first.child.stdin.end();
  await first.exited;

  const second = mcpServer(sb);
  await second.init();
  const back = await second.call('dsh_job', { job_id: single });
  check(
    '重启后 dsh_job 找回已完成作业的结果',
    /DSH ok/.test(replyText(back)) && /fake-dsh ok/.test(replyText(back)) && /运行记录/.test(replyText(back)),
    firstLine(back),
  );
  const backBatch = await second.call('dsh_job', { job_id: batch });
  const batchText = replyText(backBatch);
  check(
    '重启后并行作业逐个找回（标题 + 最终文本）',
    /2\/2 成功/.test(batchText) && /甲/.test(batchText) && /乙/.test(batchText) && (batchText.match(/fake-dsh ok/g) || []).length === 2,
    firstLine(backBatch),
  );

  // Still running when the server goes away: records say so before the workers die.
  const long = jobOf(await second.call('dsh_task', { task: 'SLEEP=30000 long', cwd: sb.dir, mode: 'async' }));
  const capped = jobOf(
    await second.call('dsh_parallel', {
      tasks: [{ title: '慢', task: 'SLEEP=30000 slow' }, { title: '排队', task: 'queued' }],
      cwd: sb.dir,
      max_concurrency: 1,
      mode: 'async',
    }),
  );
  // Wait until DSH has reported its session, so the record can name it.
  await until(() => recordsOf(long).some((meta) => meta.sessionId) && recordsOf(capped).some((meta) => meta.sessionId));
  second.child.stdin.end(); // what a host does when it reconnects
  await second.exited;
  const marked = [...recordsOf(long), ...recordsOf(capped)];
  check(
    '退出时把还在跑的 run 记录标成 interrupted 并写明原因',
    marked.length === 2 && marked.every((meta) => meta.state === 'interrupted' && /宿主断开/.test(meta.reason || '')),
    JSON.stringify(marked.map((meta) => [meta.state, meta.reason])),
  );
  check(
    '中断的记录留着子代理会话 id（可续接）',
    marked.length === 2 && marked.every((meta) => /^session-fake-/.test(meta.sessionId || '')),
  );

  const third = mcpServer(sb);
  await third.init();
  const cut = await third.call('dsh_job', { job_id: long });
  check('重启后查被打断的作业：报「已中断」', /已中断/.test(replyText(cut)) && cut.result.isError === true, firstLine(cut));
  const cutBatch = await third.call('dsh_job', { job_id: capped });
  check(
    '并行作业：跑到一半的报已中断，还在排队的报未启动',
    /1 已中断/.test(replyText(cutBatch)) && /1 未启动/.test(replyText(cutBatch)),
    firstLine(cutBatch),
  );

  // Killed outright, the server can't mark anything: "running" plus a dead pid.
  const hard = jobOf(await third.call('dsh_task', { task: 'SLEEP=3000 hard', cwd: sb.dir, mode: 'async' }));
  await until(() => recordsOf(hard).length === 1);
  third.child.kill('SIGKILL');
  await third.exited;
  check('强杀后记录仍停在 running', (recordsOf(hard)[0] || {}).state === 'running');
  const fourth = mcpServer(sb);
  await fourth.init();
  const lost = await fourth.call('dsh_job', { job_id: hard });
  check('记录是 running 但进程已不在：报「已中断」', /已中断/.test(replyText(lost)) && /已经不在/.test(replyText(lost)), firstLine(lost));

  // Still running under another live server (a second host, or an old server left alive).
  const elsewhere = jobOf(await fourth.call('dsh_task', { task: 'SLEEP=3000 elsewhere', cwd: sb.dir, mode: 'async' }));
  await until(() => recordsOf(elsewhere).length === 1);
  const fifth = mcpServer(sb);
  await fifth.init();
  const peek = await fifth.call('dsh_job', { job_id: elsewhere, wait_ms: 300 });
  check('另一个活着的服务进程在跑的作业：报运行中', /运行中/.test(replyText(peek)) && /另一个 MCP 服务进程/.test(replyText(peek)), firstLine(peek));
  const followed = await fifth.call('dsh_job', { job_id: elsewhere, wait_ms: 15_000 });
  check('跟着运行记录等到它跑完，拿到结果', /DSH ok/.test(replyText(followed)) && /fake-dsh ok/.test(replyText(followed)), firstLine(followed));
  fifth.child.kill();

  // One call never waits past 50 s, whatever it asks for.
  const caps = nodeEval(
    sb,
    `const m = require(${req('mcp.js')});` +
      'console.log(JSON.stringify([m.jobWait({ wait_ms: 60000 }), m.jobWait({ wait_ms: 0 }), m.jobWait({ wait_ms: 1500 }),' +
      ' m.softWait({ soft_wait_ms: 120000 }), m.softWait({ soft_wait_ms: 0 }) === Infinity]))',
  );
  const [jobLong, jobZero, jobShort, softLong, softZero] = JSON.parse(caps.stdout.trim() || '[]');
  check('dsh_job 的 wait_ms 过大（60000）或为 0 都封顶到 50000', jobLong === 50_000 && jobZero === 50_000 && jobShort === 1500, caps.stdout.trim() || caps.stderr);
  check('soft_wait_ms 过大封顶到 50000，0 仍是一直等', softLong === 50_000 && softZero === true, caps.stdout.trim());
  const listed = await fourth.send('tools/list', {});
  const tools = listed.result.tools;
  const prop = (name, key) => tools.find((tool) => tool.name === name).inputSchema.properties[key].description;
  check(
    '工具说明写明上限与宿主超时，不再说「不设上限」',
    /50000/.test(prop('dsh_job', 'wait_ms')) && /宿主/.test(prop('dsh_task', 'soft_wait_ms')) && !/不设上限/.test(JSON.stringify(tools)),
  );

  fourth.child.kill();
}

// ---------------------------------------------------------------- line endings

console.log('\n== 分工说明：换行符不同不算改动 ==');
{
  const sb = sandbox('eol');
  const agents = require(path.join(ROOT, 'lib', 'agents.js'));
  const file = path.join(sb.user, 'CLAUDE.md');
  fs.writeFileSync(file, '# mine\r\nkeep me\r\n');
  const fragment = 'line one\nprice is $& and $1\nline three\n';
  const first = agents.upsertBlock(file, fragment);
  const second = agents.upsertBlock(file, fragment.replace(/\n/g, '\r\n')); // another checkout's EOL
  const text = fs.readFileSync(file, 'utf8');
  check('换一种换行符再装一次：unchanged，不重写用户文件', first.status === 'written' && second.status === 'unchanged', `${first.status} → ${second.status}`);
  check('沿用文件原有的 CRLF，不产生混合换行', !/[^\r]\n/.test(text));
  check('片段里的 $ 原样写入（不被当成替换模式）', text.includes('price is $& and $1'));
  check('用户原有内容保留', text.startsWith('# mine\r\nkeep me'));
}

console.log('\n== 发布包：换行符由 .gitattributes 固定 ==');
{
  const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
  if (inGit.status !== 0) {
    console.log('  （不在 git 仓库里，跳过）');
  } else {
    // The tracked files as they are now (uncommitted edits included, so this also
    // checks before a commit); HEAD when there is nothing uncommitted.
    const snapshot = spawnSync('git', ['stash', 'create'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'HEAD';
    // Worst case: a Windows checkout with core.autocrlf=true.
    const tar = spawnSync(
      'git',
      ['-c', 'core.autocrlf=true', 'archive', '--worktree-attributes', '--format=tar', snapshot],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    const files = {};
    const modes = {};
    const buffer = tar.stdout || Buffer.alloc(0);
    for (let at = 0; at + 512 <= buffer.length; ) {
      const header = buffer.subarray(at, at + 512);
      const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
      if (!name) break;
      const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0].trim() || '0';
      const size = parseInt(field(124, 136), 8);
      files[name] = buffer.subarray(at + 512, at + 512 + size);
      modes[name] = parseInt(field(100, 108), 8);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    const sh = files['install.sh'];
    const cmd = files['install.cmd'];
    const command = files['install.command'];
    check('发布包里 install.sh 是 LF（macOS / Linux 能跑）', Boolean(sh) && !sh.includes(13), sh ? 'contains CR' : 'install.sh 不在包里');
    check('发布包里 install.cmd 是 CRLF', Boolean(cmd) && cmd.includes('\r\n'));
    check(
      '发布包里 install.command 是 LF 且可执行（macOS 双击能跑）',
      Boolean(command) && !command.includes(13) && (modes['install.command'] & 0o111) === 0o111,
      command ? `mode ${(modes['install.command'] || 0).toString(8)}` : 'install.command 不在包里',
    );
    const shipped = Object.keys(files).filter((name) => name.startsWith('installers/'));
    check('单文件安装器不进 zip（单独作为 Release 附件）', shipped.length === 0, shipped.join(', '));
  }
}

// ---------------------------------------------------------------- macOS discovery

console.log('\n== macOS：优先用 App 自带的命令行 ==');
{
  const dshLib = require(path.join(ROOT, 'lib', 'dsh.js'));
  const agentsLib = require(path.join(ROOT, 'lib', 'agents.js'));
  const sb = sandbox('macapp');
  const apps = path.join(sb.dir, 'Applications');
  const runtime = path.join(apps, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime');
  const cliFile = path.join(runtime, 'cli', 'bin', 'dsh');
  const nodeDir = path.join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin');
  fs.mkdirSync(path.join(apps, 'Other.app', 'Contents', 'Resources', 'runtime'), { recursive: true });
  check('没有自带命令行的 App 不算', dshLib.bundledCli([apps]) === null);

  for (const dir of [path.dirname(cliFile), nodeDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cliFile, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(nodeDir, 'node'), '');
  const found = dshLib.bundledCli([apps]);
  check(
    '找到 DeepSeek Harness.app 里的 runtime/cli/bin/dsh 和它旁边的 Node',
    Boolean(found) && found.kind === 'cli' && found.bundled === true && found.command === cliFile && found.nodeDirs[0] === nodeDir,
    JSON.stringify(found),
  );

  const env = dshLib.childEnv(found, { PATH: '/usr/bin:/bin' }, 'darwin');
  check(
    '运行自带命令行时，PATH 最前面是它的 Node（图形界面的客户端只给 /usr/bin:/bin）',
    env.PATH.startsWith(`${nodeDir}:${path.dirname(cliFile)}:/usr/bin:/bin`) && !env.ELECTRON_RUN_AS_NODE,
    env.PATH,
  );
  const npmEnv = dshLib.childEnv({ kind: 'cli', command: '/opt/homebrew/bin/dsh', argsPrefix: [] }, { PATH: '/usr/bin:/bin' }, 'darwin');
  check('npm 装的 dsh：它所在的目录排最前（npm 把 node 装在同一处）', npmEnv.PATH.startsWith('/opt/homebrew/bin:/usr/bin:/bin'), npmEnv.PATH);
  const desktopEnv = dshLib.childEnv({ kind: 'desktop', command: 'x', argsPrefix: [] }, { PATH: 'P' }, 'darwin');
  const winEnv = dshLib.childEnv({ kind: 'cli', command: 'C:\\npm\\dsh.cmd', argsPrefix: [] }, { PATH: 'P' }, 'win32');
  check('桌面版照旧以 Node 方式运行；Windows 上 PATH 不动', desktopEnv.ELECTRON_RUN_AS_NODE === '1' && desktopEnv.PATH === 'P' && winEnv.PATH === 'P');

  const shim = agentsLib.shimContent(found, '/Users/me/.dsh', 'darwin');
  check(
    '为自带命令行生成的 dsh 启动器带上它的 Node，路径加了引号',
    shim.includes(`export PATH='${nodeDir}'"\${PATH:+:$PATH}"`) && shim.includes(`exec '${cliFile}' "$@"`) && shim.includes('dsh-delegate shim'),
    shim,
  );
  const shims = nodeEval(
    sb,
    `const a=require(${req('agents.js')});const h=${JSON.stringify(sb.home)};` +
      `console.log(a.installShim(${JSON.stringify(found)},h,{dryRun:true}).status,` +
      `a.installShim({kind:'cli',command:'/opt/homebrew/bin/dsh',argsPrefix:[]},h,{dryRun:true}).status)`,
  );
  check('自带命令行不在 PATH 上，照样生成启动器；npm 装的 dsh 不覆盖', shims.stdout.trim() === 'would-write skipped', shims.stdout + shims.stderr);

  const explicit = nodeEval(sb, `const l=require(${req('dsh.js')}).discover();console.log(l.kind+'|'+l.command)`, { DSH_DELEGATE_CLI: cliFile });
  check('DSH_DELEGATE_CLI 可以直接指定命令行版', explicit.stdout.trim() === `cli|${cliFile}`, explicit.stdout + explicit.stderr);
  const missing = nodeEval(sb, `try{require(${req('dsh.js')}).discover()}catch(e){console.log(e.code)}`, {
    DSH_DELEGATE_CLI: path.join(sb.dir, 'nope'),
  });
  check('DSH_DELEGATE_CLI 指向不存在的文件时报 DSH_NOT_FOUND', missing.stdout.trim() === 'DSH_NOT_FOUND', missing.stdout + missing.stderr);
}

console.log('\n== 安装时补装供应商插件：按 DSH 的启动方式运行 ==');
{
  const sb = sandbox('provider');
  const profile = path.join(sb.home, 'profiles', 'headless');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    '- id: agent-default-model\n  config:\n    provider: dsh-opencode-go\n    model: deepseek-v4.1-flash\n',
  );
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  const log = path.join(sb.dir, 'fake-dsh.log');
  const run = cli(sb, ['install', '--no-clients'], { ...FAKE_DESKTOP, FAKE_DSH_LOG: log });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  const add = calls.find((call) => call.args.join(' ') === 'plugin --profile headless add dsh-opencode-go');
  check(
    '桌面版带着 ELECTRON_RUN_AS_NODE 和 DSH_HOME 运行 plugin add（否则会打开图形界面）',
    Boolean(add) && add.electron === '1' && add.dshHome === sb.home,
    JSON.stringify(calls).slice(0, 300),
  );
  const row = run.stdout.split('\n').find((line) => line.includes('provider-plugin')) || '';
  check('安装结果里这一步是 installed', /provider-plugin\s+installed/.test(row), row || run.stderr.trim().slice(0, 200));
}

// ---------------------------------------------------------------- one-file installers

/** A POSIX sh for the macOS / Linux scripts: /bin/sh, or the one Git for Windows ships. */
function posixShell() {
  if (!WIN) return fs.existsSync('/bin/sh') ? { bin: '/bin/sh', dir: '/bin' } : null;
  const found = spawnSync('where', ['git'], { encoding: 'utf8' });
  for (const line of (found.stdout || '').split(/\r?\n/).filter(Boolean)) {
    // ...\Git\cmd\git.exe or ...\Git\mingw64\bin\git.exe → ...\Git\usr\bin\sh.exe
    let dir = path.dirname(line.trim());
    for (let i = 0; i < 4; i += 1) {
      const sh = path.join(dir, 'usr', 'bin', 'sh.exe');
      if (fs.existsSync(sh)) return { bin: sh, dir: path.dirname(sh) };
      dir = path.dirname(dir);
    }
  }
  return null;
}

console.log('\n== macOS：双击运行的 install.command ==');
{
  const shell = posixShell();
  if (!shell) {
    console.log('  （没有 POSIX sh，跳过）');
  } else {
    const sb = sandbox('command');
    const elsewhere = path.join(sb.dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    // Finder starts it from the home folder, not from the package.
    const script = path.join(ROOT, 'install.command').replace(/\\/g, '/');
    const env = envFor(sb, { ...FAKE_DESKTOP, PATH: [shell.dir, path.dirname(NODE), ...SYS].join(path.delimiter) });
    const run = (...args) => spawnSync(shell.bin, [script, ...args], { cwd: elsewhere, env, encoding: 'utf8', timeout: 120_000 });
    const dry = run('--dry-run');
    check(
      '在别的目录里运行也能找到同目录的 install.sh，参数照传',
      dry.status === 0 && /dry-run/.test(dry.stdout) && !fs.existsSync(path.join(sb.home, 'bridge')),
      `exit ${dry.status} ${(dry.stderr || '').trim().slice(0, 200)}`,
    );
    const bad = run('--dryrun');
    check('安装失败时带回非 0 退出码；没有终端时不等回车', typeof bad.status === 'number' && bad.status !== 0, `exit ${bad.status}`);
  }
}

/** A release-shaped zip of this working tree: one dsh-delegate-v<version> folder. */
function stagePackage(sb) {
  const pkg = path.join(sb.dir, 'stage', 'dsh-delegate-vTEST');
  for (const entry of ['bin', 'lib', 'assets']) fs.cpSync(path.join(ROOT, entry), path.join(pkg, entry), { recursive: true });
  for (const file of ['package.json', 'install.cmd', 'install.ps1']) fs.copyFileSync(path.join(ROOT, file), path.join(pkg, file));
  const zip = path.join(sb.dir, 'dsh-delegate.zip');
  const made = spawnSync(
    path.join(SYS[0], 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath $env:PKG -DestinationPath $env:OUT'],
    { env: { ...process.env, PKG: pkg, OUT: zip }, encoding: 'utf8', timeout: 120_000 },
  );
  return made.status === 0 && fs.existsSync(zip) ? zip : null;
}

async function batSuite() {
  console.log('\n== Windows：单文件安装器 dsh-delegate-install.bat ==');
  const sb = sandbox('bat');
  const zip = stagePackage(sb);
  if (!zip) {
    check('打出测试用的安装包', false);
    return;
  }
  const temp = path.join(sb.dir, 'temp');
  fs.mkdirSync(temp);
  const syscalls = path.join(sb.dir, 'syscalls.log');
  const bat = path.join(ROOT, 'installers', 'dsh-delegate-install.bat');
  const runBat = (args, extra) =>
    new Promise((resolve) => {
      const env = envFor(sb, {
        ...FAKE_DESKTOP,
        PATH: [path.dirname(NODE), ...SYS, path.join(SYS[0], 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
        TEMP: temp,
        TMP: temp,
        DSH_DELEGATE_NO_PAUSE: '1',
        // --autostart would register the real per-user scheduled task: record it instead.
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'fixtures', 'record-system-calls.js'))}`,
        DSH_REGRESS_SYSCALLS: syscalls,
        ...extra,
      });
      const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${bat}" ${args.join(' ')}"`], {
        env,
        windowsVerbatimArguments: true,
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, out });
      });
    });
  const leftovers = () => fs.readdirSync(temp).filter((name) => name.startsWith('dsh-delegate-setup-'));

  // Stands in for github.com/.../releases/latest/download/dsh-delegate.zip.
  const server = http.createServer((req, res) => {
    if (req.url !== '/dsh-delegate.zip') {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/zip' });
    fs.createReadStream(zip).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await runBat(['--no-clients', '--autostart'], { DSH_DELEGATE_ZIP_URL: `${base}/dsh-delegate.zip` });
    const bridgeCli = path.join(sb.home, 'bridge', 'bin', 'dsh-delegate.js');
    check('下载最新包、解压、安装，退出码 0', run.status === 0 && fs.existsSync(bridgeCli), `exit ${run.status} ${run.out.trim().slice(-300)}`);
    check('装完删掉临时目录', leftovers().length === 0, leftovers().join(', '));
    const vbs = path.join(sb.appdata, 'dsh-delegate', 'daemon.vbs');
    const launcher = fs.existsSync(vbs) ? fs.readFileSync(vbs, 'utf8') : '';
    check(
      '--autostart 跑 ~/.dsh/bridge 里的副本，不指向装完就删的临时目录',
      launcher.includes(bridgeCli) && !launcher.includes(temp),
      launcher.split('\n').find((line) => line.includes('shell.Run')) || '(no daemon.vbs)',
    );
    const calls = fs.existsSync(syscalls) ? fs.readFileSync(syscalls, 'utf8') : '';
    check('（测试里 schtasks 只记录、不真的注册）', /\["schtasks","\/create"/.test(calls), calls.trim().slice(0, 200));

    const missing = await runBat([], { DSH_DELEGATE_ZIP_URL: `${base}/missing.zip` });
    check(
      '下载失败：退出码 1，提示开代理或改用 DSH_DELEGATE_ZIP，不留临时目录',
      missing.status === 1 && /Could not download/.test(missing.out) && /DSH_DELEGATE_ZIP=/.test(missing.out) && leftovers().length === 0,
      `exit ${missing.status} ${missing.out.trim().slice(-200)}`,
    );
    const local = await runBat(['--dry-run', '--targets=codex'], { DSH_DELEGATE_ZIP: zip });
    check(
      'DSH_DELEGATE_ZIP 装本地包，参数原样传给 install.cmd',
      local.status === 0 && /dry-run/.test(local.out) && /client:codex/.test(local.out) && !/client:claude-desktop/.test(local.out),
      `exit ${local.status} ${local.out.trim().slice(-300)}`,
    );
    const broken = await runBat([], { DSH_DELEGATE_ZIP: path.join(sb.dir, 'nope.zip') });
    check('本地包不存在：退出码 1，不留临时目录', broken.status === 1 && leftovers().length === 0, `exit ${broken.status}`);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- quota-aware delegation

function mcpInstructions(sb, clientName) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, 'lib', 'mcp.js')], { env: envFor(sb, FAKE_DESKTOP) });
    let buffer = '';
    const finish = (text) => {
      child.kill();
      resolve(text);
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const line = buffer.split('\n').find((item) => item.includes('"instructions"'));
      if (line) finish(JSON.parse(line).result.instructions);
    });
    setTimeout(() => finish(''), 10_000);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1' } } })}\n`,
    );
  });
}

async function quotaSuite() {
  console.log('\n== 额度快用完时多派给 DSH ==');
  const sb = sandbox('quota');
  const run = (args, input, extra) =>
    spawnSync(NODE, [CLI, ...args], { env: envFor(sb, extra), encoding: 'utf8', input, timeout: 60_000 });
  const later = Math.floor(Date.now() / 1000) + 3600;
  const statusInput = (fiveHour) =>
    JSON.stringify({
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 12 },
      rate_limits: {
        five_hour: { used_percentage: fiveHour, resets_at: later },
        seven_day: { used_percentage: 30, resets_at: later + 86_400 },
      },
    });
  const contextOf = (result) => {
    try {
      return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    } catch {
      return '';
    }
  };

  const low = run(['statusline'], statusInput(20));
  check('statusline 输出一行底栏（模型、上下文、额度）', low.status === 0 && /\[Opus\]/.test(low.stdout) && /5h 20%/.test(low.stdout), low.stdout.trim());
  check('statusline 把额度记到 $DSH_HOME/quota/claude.json', fs.existsSync(path.join(sb.home, 'quota', 'claude.json')));
  const quiet = run(['hook', 'prompt'], '{}');
  check('额度不高时 hook 什么都不加', quiet.status === 0 && quiet.stdout.trim() === '', quiet.stdout.trim());

  const high = run(['statusline'], statusInput(82));
  check('用到 82%：底栏显示「DSH 多派」', /DSH 多派/.test(high.stdout), high.stdout.trim());
  const nudge = contextOf(run(['hook', 'prompt'], '{}'));
  check('用到 82%：hook 要求优先派给 DSH', /82%/.test(nudge) && /dsh_task/.test(nudge), nudge.slice(0, 80));

  run(['statusline'], statusInput(95));
  const urgent = contextOf(run(['hook', 'prompt'], '{}'));
  check('用到 95%：提醒升级为「全派」', /全部派给 DSH/.test(urgent), urgent.slice(0, 80));

  const bom = run(['statusline'], `\uFEFF${statusInput(95)}`);
  check('statusline 能处理带 BOM 的 stdin', bom.status === 0 && /\[Opus\]/.test(bom.stdout) && /5h 95%/.test(bom.stdout), bom.stdout.trim());

  check('statusline 收到坏输入照常输出', /DSH/.test(run(['statusline'], 'not json').stdout));
  check('hook 收到坏输入照常退出', run(['hook', 'prompt'], 'not json').status === 0);
  // A sample without resets_at (hand-fed or partial) must still expire.
  const quotaFile = path.join(sb.home, 'quota', 'claude.json');
  const saved = fs.readFileSync(quotaFile, 'utf8');
  const fed = (ageMs) =>
    fs.writeFileSync(quotaFile, JSON.stringify({ source: 'claude', at: Date.now() - ageMs, windows: { five_hour: { used: 82 }, seven_day: { used: 41 } } }));
  fed(6 * 3600_000);
  const stale = contextOf(run(['hook', 'prompt'], '{}'));
  check('没有重置时间、6 小时前记下的 5 小时窗口已失效', !/5 小时 82%/.test(stale), stale.slice(0, 60));
  fed(3600_000);
  check('同样的数据 1 小时前记下的仍然有效', /82%/.test(contextOf(run(['hook', 'prompt'], '{}'))));
  fs.writeFileSync(quotaFile, saved);

  const codexHome = path.join(sb.dir, 'codex-noreset');
  const dayDir = path.join(codexHome, 'sessions', '2026', '11', '14');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-noreset.jsonl');
  fs.writeFileSync(
    rollout,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 88, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } } } })}\n`,
  );
  const sixHoursAgo = (Date.now() - 6 * 3600_000) / 1000;
  fs.utimesSync(rollout, sixHoursAgo, sixHoursAgo);
  const codexSnap = require(path.join(ROOT, 'lib', 'quota.js')).readCodex(Date.now(), codexHome);
  check(
    'Codex 没有重置时间的窗口按 window_minutes 过期（5 小时已过、本周仍在）',
    Boolean(codexSnap) && !codexSnap.windows.five_hour && Boolean(codexSnap.windows.seven_day),
    JSON.stringify(codexSnap && codexSnap.windows),
  );

  const listing = run(['quota'], '');
  check('quota 命令列出 Claude 和 Codex', listing.status === 0 && /Claude/.test(listing.stdout) && /Codex/.test(listing.stdout), listing.stdout.trim());

  // Codex sessions start with Codex's own quota; Claude clients with Claude's.
  const day = path.join(sb.user, '.codex', 'sessions', '2026', '11', '14');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, 'rollout-test.jsonl'),
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 93, window_minutes: 300, resets_at: later }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: later + 86_400 } } } })}\n`,
  );
  const codexNote = await mcpInstructions(sb, 'codex-mcp-client');
  check('Codex 会话开始时说明里带 Codex 的额度', /Codex/.test(codexNote) && /93%/.test(codexNote), codexNote.slice(-120));
  const claudeNote = await mcpInstructions(sb, 'claude-code');
  check('Claude 会话开始时说明里带 Claude 的额度', /Claude/.test(claudeNote) && /95%/.test(claudeNote), claudeNote.slice(-120));

  // install --usage-hooks edits Claude Code's settings.json carefully.
  const settings = path.join(sb.user, 'settings.json'); // CLAUDE_CONFIG_DIR is the sandbox home
  run(['install', '--no-clients', '--usage-hooks'], '', FAKE_DESKTOP);
  const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const ourHook = wired.hooks && wired.hooks.UserPromptSubmit && wired.hooks.UserPromptSubmit[0].hooks[0];
  check('--usage-hooks 写入 statusLine 和 UserPromptSubmit hook', /statusline$/.test(wired.statusLine.command) && /hook prompt$/.test(ourHook.command));
  check('命令里只用正斜杠（Git Bash / PowerShell 都能解析）', !wired.statusLine.command.includes('\\') && !ourHook.command.includes('\\'));
  const again = run(['install', '--no-clients', '--usage-hooks'], '', FAKE_DESKTOP);
  check(
    '再装一次全是 unchanged，不重复添加',
    /claude-statusline\s+unchanged/.test(again.stdout) && /claude-prompt-hook\s+unchanged/.test(again.stdout) &&
      JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.UserPromptSubmit.length === 1,
    again.stdout.split('\n').filter((line) => /claude-/.test(line)).join(' | '),
  );

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'bash ~/mine.sh' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  run(['install', '--no-clients', '--usage-hooks'], '', FAKE_DESKTOP);
  const merged = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check('用户自己的 statusLine 不动', merged.statusLine.command === 'bash ~/mine.sh');
  check('用户自己的 hook 和其它设置保留，另加我们的', merged.theme === 'dark' && merged.hooks.UserPromptSubmit.length === 2);
  run(['uninstall'], '', FAKE_DESKTOP);
  const left = JSON.parse(fs.readFileSync(settings, 'utf8'));
  check(
    '卸载只删我们加的 hook，别的都留着',
    left.statusLine.command === 'bash ~/mine.sh' && left.hooks.UserPromptSubmit.length === 1 && left.hooks.UserPromptSubmit[0].hooks[0].command === 'echo mine',
  );
}

// ---------------------------------------------------------------- keeping the service alive

function rawRequest(port, line) {
  return new Promise((resolve) => {
    const socket = require('node:net').connect(port, '127.0.0.1', () =>
      socket.end(`${line}\r\nHost: 127.0.0.1:${port}\r\n\r\n`),
    );
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('close', () => resolve(text.split('\r\n')[0] || '(no response)'));
    socket.on('error', (error) => resolve(`ERR ${error.message}`));
  });
}

async function serviceSuite() {
  console.log('\n== 本机服务：看门狗、坏请求、端口不漂移 ==');
  const autostart = require(path.join(ROOT, 'lib', 'autostart.js'));
  const xml = autostart.windowsTaskXml({ vbs: 'C:\\x & y\\daemon.vbs', userId: 'PC\\me', start: '2026-11-16T09:00:00' });
  check(
    'Windows 计划任务：登录时 + 定时，每 5 分钟重复',
    /<LogonTrigger>[\s\S]*PT5M[\s\S]*<\/LogonTrigger>/.test(xml) && /<TimeTrigger>[\s\S]*PT5M[\s\S]*<\/TimeTrigger>/.test(xml),
  );
  check(
    '计划任务：用电池也跑、不重复启动、指向自己的启动脚本（已转义）',
    /<DisallowStartIfOnBatteries>false/.test(xml) && /<MultipleInstancesPolicy>IgnoreNew/.test(xml) &&
      xml.includes('//B "C:\\x &amp; y\\daemon.vbs"'),
  );
  const plist = autostart.macPlist({ args: ['/n/node', '/b/cli.js', 'daemon'], log: '/h/.dsh/out.log' });
  check('macOS LaunchAgent：异常退出才重启', /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/.test(plist));

  const sb = sandbox('service');
  const port = 30000 + Math.floor(Math.random() * 10000);
  const first = spawn(NODE, [CLI, 'daemon', `--port=${port}`, '--no-ui'], { env: envFor(sb), stdio: 'ignore' });
  const log = path.join(sb.home, 'delegate-daemon.log');
  for (let i = 0; i < 50 && !(fs.existsSync(log) && /started/.test(fs.readFileSync(log, 'utf8'))); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('服务启动时写日志', fs.existsSync(log) && /pid \d+ started http:\/\/127\.0\.0\.1:\d+/.test(fs.readFileSync(log, 'utf8')));

  const bad = await rawRequest(port, 'GET //[ HTTP/1.1');
  const empty = await rawRequest(port, 'GET // HTTP/1.1');
  const alive = await request(`http://127.0.0.1:${port}`, 'GET', '/api/service');
  check('地址格式错误的请求得到 400，服务不会因此退出', /400/.test(bad) && /400/.test(empty) && alive.status === 200, `${bad} | ${empty} | ${alive.status}`);

  // A second copy (no state file to tell it) on the same port must leave the first alone.
  const other = sandbox('service2');
  const second = spawnSync(NODE, [CLI, 'daemon', `--port=${port}`, '--no-ui'], { env: envFor(other), encoding: 'utf8', timeout: 30_000 });
  const drifted = await request(`http://127.0.0.1:${port + 1}`, 'GET', '/api/service');
  check('同端口第二个实例识别出“已在运行”并退出', second.status === 0 && /已在运行/.test(second.stdout), (second.stdout + second.stderr).trim());
  check('不会悄悄换到下一个端口', drifted.status === 0, `port+1 → ${drifted.status}`);

  const logged = spawnSync(NODE, ['-e', `require(${req('daemon.js')}).logLine('probe-line')`], { env: envFor(other), encoding: 'utf8' });
  const otherLog = path.join(other.home, 'delegate-daemon.log');
  check('logLine 追加带时间和 pid 的一行', logged.status === 0 && fs.existsSync(otherLog) && /Z pid \d+ probe-line/.test(fs.readFileSync(otherLog, 'utf8')));
  first.kill();
}

// ---------------------------------------------------------------- bundle

console.log('\n== 插件包里的服务与 lib/ 同步 ==');
{
  const drift = fs
    .readdirSync(path.join(ROOT, 'lib'))
    .filter((name) => {
      const bundled = path.join(ROOT, 'plugin', 'server', 'lib', name);
      return !fs.existsSync(bundled) || !fs.readFileSync(bundled).equals(fs.readFileSync(path.join(ROOT, 'lib', name)));
    });
  check('plugin/server/lib 与 lib 一致（不一致就跑 npm run sync:plugin）', drift.length === 0, drift.join(', '));
}

(async () => {
  await httpSuite();
  await mcpSuite();
  await jobRecoverySuite();
  await quotaSuite();
  await serviceSuite();
  if (WIN) await batSuite();
  for (const dir of sandboxes) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a straggling child may still hold a file */
    }
  }
  console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`);
  if (failures.length) {
    console.log('\n失败项:');
    for (const item of failures) console.log(`  - ${item}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
