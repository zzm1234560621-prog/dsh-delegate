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

async function mcpSuite() {
  console.log('\n== MCP：取消只影响自己的作业；进度通知不越过响应 ==');
  const sb = sandbox('mcp');
  const child = spawn(NODE, [path.join(ROOT, 'lib', 'mcp.js')], { env: envFor(sb, FAKE_DESKTOP) });
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
  const text = (reply) => reply.result.content[0].text;
  const jobOf = (reply) => (text(reply).match(/job=(dsh-[\w-]+)/) || [])[1];
  const call = (name, args, meta) => send('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });

  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'regress', version: '1' } });

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
    // Worst case: a Windows checkout with core.autocrlf=true.
    const tar = spawnSync(
      'git',
      ['-c', 'core.autocrlf=true', 'archive', '--worktree-attributes', '--format=tar', 'HEAD', '--', 'install.sh', 'install.cmd'],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    const files = {};
    const buffer = tar.stdout || Buffer.alloc(0);
    for (let at = 0; at + 512 <= buffer.length; ) {
      const header = buffer.subarray(at, at + 512);
      const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
      if (!name) break;
      const size = parseInt(header.subarray(124, 136).toString('utf8').split('\0')[0].trim() || '0', 8);
      files[name] = buffer.subarray(at + 512, at + 512 + size);
      at += 512 + Math.ceil(size / 512) * 512;
    }
    const sh = files['install.sh'];
    const cmd = files['install.cmd'];
    check('发布包里 install.sh 是 LF（macOS / Linux 能跑）', Boolean(sh) && !sh.includes(13), sh ? 'contains CR' : 'install.sh 不在包里');
    check('发布包里 install.cmd 是 CRLF', Boolean(cmd) && cmd.includes('\r\n'));
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
  await quotaSuite();
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
