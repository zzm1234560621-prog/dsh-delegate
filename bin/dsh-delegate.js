#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('../package.json');
const dsh = require('../lib/dsh');
const targets = require('../lib/targets');
const agents = require('../lib/agents');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (const token of argv) {
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) args[body] = true;
      else args[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      args._.push(token);
    }
  }
  return args;
}

const KNOWN_FLAGS = {
  install: ['dry-run', 'targets', 'no-clients', 'autostart', 'port', 'copy-credentials', 'usage-hooks', 'dsh-app'],
  uninstall: ['remove-runtime', 'keep-clients', 'dsh-app'],
};

/** Commands that change the machine refuse unknown input: `--dryrun` must not run for real. */
function assertKnownFlags(command, args) {
  const allowed = KNOWN_FLAGS[command];
  if (!allowed) return;
  const unknown = Object.keys(args)
    .filter((key) => key !== '_' && !allowed.includes(key))
    .map((key) => `--${key}`);
  const stray = args._.slice(1);
  if (unknown.length || stray.length) {
    throw new Error(
      `${command} 不认识这些参数：${[...unknown, ...stray].join(' ')}\n  可用：${allowed.map((key) => `--${key}`).join(' ')}`,
    );
  }
}

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

function table(rows) {
  for (const row of rows) log(row);
}

function copyRuntime(dest) {
  // Stage into a sibling directory and swap, so an interrupted install can never
  // leave a half-copied runtime behind (e.g. lib/ missing).
  const stage = `${dest}.staging-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  const put = (root) => {
    for (const entry of ['lib', 'assets', 'bin']) {
      fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  };

  try {
    put(stage);

    // Swap in the new tree. While the service runs from dest, Windows refuses the
    // rename (EBUSY/EACCES/EPERM) because the directory holds open handles; fall
    // back to overwriting in place, which works since Node already read the JS.
    const backup = `${dest}.old-${process.pid}`;
    try {
      if (fs.existsSync(dest)) fs.renameSync(dest, backup);
      fs.renameSync(stage, dest);
      fs.rmSync(backup, { recursive: true, force: true });
      return { mode: 'atomic' };
    } catch (cause) {
      if (!['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY'].includes(cause.code)) throw cause;
      put(dest);
      fs.rmSync(stage, { recursive: true, force: true });
      return { mode: 'in-place' };
    }
  } catch (cause) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw cause;
  }
}

function bridgeDir() {
  return path.join(dsh.dshHome(), 'bridge');
}

function runtimeContext() {
  return {
    nodePath: process.execPath,
    mcpPath: path.join(bridgeDir(), 'lib', 'mcp.js'),
    cliPath: path.join(bridgeDir(), 'bin', 'dsh-delegate.js'),
    nodeOnPath: Boolean(dsh.which('node')),
    dshHome: dsh.dshHome(),
  };
}

/** Spawn the deployed entry point and require a JSON-RPC reply, so a broken
 *  entry (e.g. a module that only exports and exits) fails the install loudly. */
function verifyEntry(mcpPath) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [mcpPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (out.includes('"result"')) done(true);
    });
    child.on('exit', () => done(out.includes('"result"')));
    child.on('error', () => done(false));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-check', version: '1' } },
      }) + '\n',
    );
    setTimeout(() => done(out.includes('"result"')), 5000);
  });
}

function parseTargets(value) {
  const all = ['claude-desktop', 'claude-code', 'codex'];
  if (!value || value === true) return all;
  const list = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = list.filter((item) => !all.includes(item));
  if (unknown.length) throw new Error(`未知目标：${unknown.join(', ')}（可选：${all.join(', ')}）`);
  return list;
}

async function commandInstall(args) {
  const dryRun = Boolean(args['dry-run']);
  const launch = dsh.discover();
  const ctx = runtimeContext();

  log(`DSH: ${launch.kind === 'desktop' ? '桌面版' : 'CLI'} — ${launch.detail}`);
  log(`运行时目录: ${bridgeDir()}${dryRun ? '（dry-run，不写入）' : ''}`);
  log('');

  if (!dryRun) copyRuntime(bridgeDir());

  const results = [];

  if (!dryRun) {
    const ok = await verifyEntry(ctx.mcpPath);
    results.push({ what: 'verify', status: ok ? 'ok' : 'FAILED', file: ok ? ctx.mcpPath : `${ctx.mcpPath}（没有响应 MCP 握手）` });
    if (!ok) process.exitCode = 1;
  }
  results.push({ what: 'shim', ...agents.installShim(launch, ctx.dshHome, { dryRun }) });
  for (const item of agents.installSkill(ctx.dshHome, { dryRun })) results.push({ what: 'skill', ...item });
  for (const item of agents.installInstructions(ctx.dshHome, { dryRun })) results.push({ what: 'instructions', ...item });

  if (!args['no-clients']) {
    for (const item of targets.applyAll(parseTargets(args.targets), ctx, { dryRun })) {
      results.push({ what: `client:${item.target}`, ...item });
    }
  }

  // Opt-in: Claude Code records its plan quota and gets told to delegate more when low.
  if (args['usage-hooks']) {
    for (const item of require('../lib/claude-hooks').apply(ctx, { dryRun })) {
      results.push({ what: item.target, ...item });
    }
  }

  if (args.autostart && !dryRun) {
    // Run the copy just deployed to the bridge, not this package: the folder an
    // installer runs from is often temporary (dsh-delegate-install.bat deletes it).
    const result = require('../lib/autostart').enable({ port: Number(args.port) || 7788, cli: ctx.cliPath });
    results.push({ what: 'autostart', status: 'written', file: `${result.mechanism} → ${result.target}` });
  }

  if (args['copy-credentials'] && !dryRun) {
    const copied = copyCredentials(ctx.dshHome);
    log(copied ? `凭据: ${copied}` : '凭据: 没有可复制的 DEEPSEEK_API_KEY（跳过）');
  }

  log('安装结果：');
  for (const item of results) {
    const where = item.file || item.detail || '';
    log(`  ${item.what.padEnd(22)} ${String(item.status).padEnd(12)} ${where}`);
  }

  if (!dryRun) {
    const envFile = path.join(ctx.dshHome, '.env');
    const hasKey = fs.existsSync(envFile) && /^[A-Z_]+=.+/m.test(fs.readFileSync(envFile, 'utf8'));
    if (!hasKey && !process.env.DEEPSEEK_API_KEY) {
      log('');
      log('⚠ 没检测到凭据：headless 不读 DSH 桌面版里保存的 key，要单独配一次。');
      log('  不配的话，第一次派活会报 MISSING_CREDENTIAL。在看板里配：');
      log(`    node "${path.join(bridgeDir(), 'bin', 'dsh-delegate.js')}" ui --open`);
      log('    →「执行模型与凭据」：选供应商和模型，填 key，写入 .env，保存模型');
      log('  只用 DeepSeek 的话，也可以重跑本命令加 --copy-credentials，从 DSH 里搬现成的 key。');
    }
  }

  log('');
  log('下一步：');
  log('  1. 重启 Claude 桌面版 / 重新打开 Claude Code 会话，工具列表里会出现 dsh_task / dsh_parallel / dsh_job。');
  log(`  2. 自检：node "${path.join(bridgeDir(), 'bin', 'dsh-delegate.js')}" doctor --run`);
  log('  3. 在会话里说「把这个简单活派给 DSH」，或直接调用 dsh_task。');
  if (dryRun) log('\n（dry-run：未写入任何文件）');
}

function copyCredentials(dshHomeDir) {
  const credentials = path.join(dshHomeDir, '.credentials.yaml');
  if (!fs.existsSync(credentials)) return null;
  const text = fs.readFileSync(credentials, 'utf8');
  const key = (text.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9_-]+)/) || [])[1];
  if (!key) return null;
  const envFile = path.join(dshHomeDir, '.env');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (/^DEEPSEEK_API_KEY=/m.test(existing)) return '已存在 DEEPSEEK_API_KEY（未改动）';
  fs.writeFileSync(envFile, `${existing.replace(/\s*$/, existing.trim() ? '\n' : '')}DEEPSEEK_API_KEY=${key}\n`);
  return `写入 ${envFile}`;
}

function commandUninstall(args) {
  // Load everything up front: --remove-runtime may delete the very files this runs from.
  const autostart = require('../lib/autostart');
  const daemon = require('../lib/daemon').status();
  const removed = [];
  removed.push({ what: 'shim', ...agents.removeShim() });
  for (const item of agents.removeSkill(dsh.dshHome())) removed.push({ what: 'skill', ...item });
  for (const item of agents.removeInstructions(dsh.dshHome())) removed.push({ what: 'instructions', ...item });
  if (!args['keep-clients']) {
    // Only entries that start a dsh-delegate mcp.js; someone else's "dsh" server stays.
    for (const item of targets.removeAll()) removed.push({ what: `client:${item.target}`, ...item });
    // The statusLine / prompt hook that `install --usage-hooks` added, nothing else.
    for (const item of require('../lib/claude-hooks').remove()) removed.push({ what: item.target, ...item });
  }
  if (autostart.status().ours) {
    const after = autostart.disable();
    removed.push({ what: 'autostart', status: after.enabled ? 'FAILED' : 'removed', file: after.target });
  }

  log('卸载结果：');
  for (const item of removed) {
    log(`  ${item.what.padEnd(22)} ${String(item.status).padEnd(10)} ${item.file || ''}${item.detail ? `（${item.detail}）` : ''}`);
  }
  if (args['keep-clients']) log('  （--keep-clients：客户端配置里的 dsh 条目保留）');
  if (args['remove-runtime']) {
    fs.rmSync(bridgeDir(), { recursive: true, force: true });
    log(`已删除运行时目录 ${bridgeDir()}`);
  }
  if (daemon.running) log(`提示：本地服务仍在运行（pid ${daemon.pid}），结束该进程或重启后消失。`);
  log('重启 Claude 桌面版 / 重新打开 Claude Code 后，dsh 工具会从列表里消失。');
}

function commandDoctor(args) {
  const checks = [];
  checks.push({ name: 'Node', ok: Number(process.versions.node.split('.')[0]) >= 18, detail: process.versions.node });
  let launch = null;
  try {
    launch = dsh.discover();
    checks.push({ name: 'DSH', ok: true, detail: `${launch.kind} — ${launch.detail}` });
  } catch (cause) {
    checks.push({ name: 'DSH', ok: false, detail: cause.message.split('\n')[0] });
  }

  const home = dsh.dshHome();
  checks.push({ name: 'DSH_HOME', ok: fs.existsSync(home), detail: home });
  checks.push({
    name: 'headless profile',
    ok: fs.existsSync(path.join(home, 'profiles', 'headless')),
    detail: path.join(home, 'profiles', 'headless'),
  });
  checks.push({
    name: '.env credentials',
    ok: fs.existsSync(path.join(home, '.env')),
    detail: fs.existsSync(path.join(home, '.env')) ? 'present' : '缺少；在看板「执行模型与凭据」里配（dsh-delegate ui --open）',
  });

  const desktop = targets.claudeDesktopConfigs();
  checks.push({ name: 'Claude Desktop config', ok: desktop.length > 0, detail: desktop[0] || '未找到' });
  checks.push({ name: 'Codex config', ok: fs.existsSync(targets.codexConfigPath()), detail: targets.codexConfigPath() });

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    log(`${check.ok ? '✓' : '✗'} ${check.name.padEnd(22)} ${check.detail}`);
  }

  if (args.run) {
    if (!launch) {
      log('\n跳过实际调用：DSH 不可用。');
    } else {
      log('\n实跑一次（约 10-40s）…');
      return dsh
        .runTask({ task: '只回复两个字：可用', timeoutMs: 180_000 })
        .then((result) => {
          log(result.ok ? `✓ 调用成功：${result.text.trim()}（${Math.round(result.durationMs / 1000)}s）` : `✗ 调用失败：${result.reason || result.stderrTail}`);
          if (failed > 0) process.exitCode = 1;
        });
    }
  }
  if (failed > 0) process.exitCode = 1;
}

/** Copy-paste snippets for clients the installer does not wire itself. */
function commandPrintConfig() {
  const ctx = runtimeContext();
  const q = (value) => (/\s/.test(value) ? `"${value}"` : value);
  const entry = { command: ctx.nodePath, args: [ctx.mcpPath], env: { DSH_HOME: ctx.dshHome } };
  let launch;
  try {
    launch = dsh.installCommand(dsh.discover());
  } catch (cause) {
    launch = `（没找到 DSH：${cause.message.split('\n')[0]}）`;
  }
  log('# Claude 桌面版，以及其他用 mcpServers JSON 的 MCP 客户端');
  log(JSON.stringify({ mcpServers: { [targets.SERVER_NAME]: entry } }, null, 2));
  log('');
  log('# Codex：~/.codex/config.toml');
  log(targets.codexBlock(ctx).join('\n'));
  log('');
  log('# Claude Code');
  log(`claude mcp add --scope user ${targets.SERVER_NAME} -e DSH_HOME=${q(ctx.dshHome)} -- ${q(ctx.nodePath)} ${q(ctx.mcpPath)}`);
  log('');
  log('# DSH headless 启动命令');
  log(launch);
}

// ---------------------------------------------------------------- quota-aware delegation

const LEVEL_LABEL = { normal: '正常', high: '多派', critical: '全派', unknown: '无数据' };

/** Whatever arrives on stdin within `timeoutMs` (hooks and status lines pipe JSON in). */
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    const done = () => {
      clearTimeout(timer);
      // A shell that pipes a string (PowerShell, some harnesses) can prefix a UTF-8 BOM.
      resolve(data.charCodeAt(0) === 0xfeff ? data.slice(1) : data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function windowsText(snapshot) {
  const windows = (snapshot && snapshot.windows) || {};
  return [
    windows.five_hour ? `5h ${Math.round(windows.five_hour.used)}%` : null,
    windows.seven_day ? `周 ${Math.round(windows.seven_day.used)}%` : null,
  ].filter(Boolean);
}

/**
 * Claude Code statusLine: record the plan quota it reports, print a one-line footer.
 * It runs on every UI refresh, so it must be quick and must never print an error.
 */
async function commandStatusline() {
  let line = 'DSH';
  try {
    const input = await readStdin(1500);
    let data = {};
    try {
      data = JSON.parse(input || '{}') || {};
    } catch {
      data = {};
    }
    const quota = require('../lib/quota');
    const snapshot = quota.recordClaude(data) || quota.readClaude();
    const level = quota.level(snapshot);
    const model = data.model && data.model.display_name;
    const context = data.context_window && Number(data.context_window.used_percentage);
    const head = [model ? `[${model}]` : null, Number.isFinite(context) ? `ctx ${Math.round(context)}%` : null].filter(Boolean);
    const usage = windowsText(snapshot);
    if (snapshot && snapshot.limit) usage.push('已触顶');
    const tag = level === 'high' || level === 'critical' ? `DSH ${LEVEL_LABEL[level]}` : 'DSH';
    line = [head.join(' '), usage.join(' · '), tag].filter(Boolean).join(' | ');
  } catch {
    /* the footer still shows "DSH" */
  }
  process.stdout.write(`${line}\n`);
  process.exit(0);
}

/** Claude Code hooks. `prompt` (UserPromptSubmit): ask Claude to delegate more when quota runs low. */
async function commandHook(args) {
  await readStdin(1000);
  try {
    if (args._[1] === 'prompt') {
      const quota = require('../lib/quota');
      const text = quota.advice(quota.readClaude(), 'Claude');
      if (text) {
        process.stdout.write(
          `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })}\n`,
        );
      }
    }
  } catch {
    /* a hook must never get in the way of the prompt */
  }
  process.exit(0);
}

function commandQuota() {
  const quota = require('../lib/quota');
  const summary = quota.summary();
  const { high, critical } = summary.thresholds;
  log(`档位：用到 ${high}% 起「多派」，${critical}% 起「全派」（看板里可改）`);
  for (const [name, item] of [['Claude', summary.claude], ['Codex', summary.codex]]) {
    const parts = windowsText(item.snapshot);
    const limit = item.snapshot && item.snapshot.limit;
    if (limit) {
      const reset = quota.formatReset(limit.resetsAt);
      parts.unshift(`已触顶（${quota.limitLabel(limit.type)}${reset ? `，${reset} 重置` : ''}）`);
    }
    const age = item.snapshot ? `，${Math.max(0, Math.round((Date.now() - item.snapshot.at) / 60000))} 分钟前的数据` : '';
    log(`  ${name.padEnd(7)} ${LEVEL_LABEL[item.level] || item.level}  ${parts.join(' · ') || '—'}${age}`);
  }
  if (summary.claude.level === 'unknown') {
    log('  Claude 没有数据：在终端里用 Claude Code 并装了 --usage-hooks 才会记录额度。');
  }
}

function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function commandUi(args) {
  return commandDaemon({ ...args, 'no-ui': false });
}

async function commandDaemon(args) {
  const settings = require('../lib/config').readSettings();
  const port = Number(args.port) || settings.daemonPort || 7788;
  const withUi = args['no-ui'] ? false : args.ui ? true : settings.daemonUi !== false;
  const daemon = require('../lib/daemon');
  const running = daemon.status();
  if (running.running) {
    log(`服务已在运行: ${running.url} (pid ${running.pid}, ${running.ui ? 'API + 看板' : '仅 API'})`);
    if (withUi && args.open) openBrowser(running.url);
    return;
  }
  let started;
  try {
    started = await daemon.run({ port, ui: withUi });
  } catch (cause) {
    if (cause.code !== 'EADDRINUSE') throw cause;
    // Taken by another copy of this service (state file lost, or the watchdog racing a
    // start): fine, leave it. Taken by something else: say so instead of drifting to
    // another port the DSH panel would never find.
    const url = `http://127.0.0.1:${port}`;
    if (await isOurService(port)) {
      log(`服务已在运行: ${url}（端口已被现有实例占用）`);
      if (withUi && args.open) openBrowser(url);
      return;
    }
    throw new Error(`端口 ${port} 被别的程序占用；用 --port= 换一个，或在看板里改端口`);
  }
  if (withUi && args.open) openBrowser(started.url);
  // keep the process alive: daemon.run returns after the server starts
  await new Promise(() => {});
}

/** Does a dsh-delegate service answer on this port? */
function isOurService(port) {
  return new Promise((resolve) => {
    const request = require('node:http').get({ host: '127.0.0.1', port, path: '/api/service', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && 'running' in JSON.parse(body));
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

function commandAutostart(args) {
  const action = args._[1] || 'status';
  const autostart = require('../lib/autostart');
  const port = Number(args.port) || 7788;
  if (action === 'on') {
    // Same as install: prefer the deployed runtime over wherever this copy runs from.
    const deployed = runtimeContext().cliPath;
    const result = autostart.enable({ port, cli: fs.existsSync(deployed) ? deployed : undefined });
    require('../lib/config').writeSettings({ daemonAutostart: true, daemonPort: port });
    log(`已开启登录自启动（${result.mechanism}）：${result.target}`);
    const ui = require('../lib/config').readSettings().daemonUi !== false;
    log(`  启动内容：dsh-delegate daemon${ui ? '' : ' --no-ui'} --port=${port}`);
    return;
  }
  if (action === 'off') {
    const result = autostart.disable();
    require('../lib/config').writeSettings({ daemonAutostart: false });
    log(`已关闭登录自启动（${result.mechanism}）。`);
    return;
  }
  const status = autostart.status();
  const daemon = require('../lib/daemon').status();
  log(`自启动：${status.enabled ? '已开启' : '未开启'}（${status.mechanism}）`);
  log(`  目标：${status.target}`);
  log(`服务：${daemon.running ? `运行中 ${daemon.url} (pid ${daemon.pid})` : '未运行'}`);
}

function commandRetry(args) {
  const resume = require('../lib/resume');
  const limit = Number(args.limit) || 8;
  const concurrency = Number(args.concurrency) || 2;
  const ids = typeof args.id === 'string' ? [args.id] : Array.isArray(args.id) ? args.id : null;
  const force = Boolean(args.force) || Boolean(args.all);
  const { candidates, skipped } = resume.pickCandidates({ ids, limit, force });
  if (!candidates.length) {
    log('没有可继续的任务。' + (skipped.length ? `（跳过 ${skipped.length} 条）` : ''));
    return;
  }
  log(`继续 ${candidates.length} 个任务（并发 ${concurrency}）…`);
  for (const run of candidates) log(`  · ${run.title || run.id} — ${run.reason || ''}`.trim());
  resume
    .resumeMany(candidates, { concurrency })
    .then(({ results, failed }) => {
      log(`完成：${results.length - failed} 成功，${failed} 失败。`);
      for (const item of results) {
        if (!item.ok) log(`  ✗ ${item.source}: ${item.reason || '失败'}`);
      }
    })
    .catch((cause) => log(`继续失败：${cause.message}`));
}

function commandStatus() {
  const daemon = require('../lib/daemon').status();
  const autostart = require('../lib/autostart').status();
  log(`服务：${daemon.running ? `运行中 ${daemon.url}` : '未运行'}`);
  if (daemon.running) log(`  pid ${daemon.pid} · ${daemon.ui ? 'API + 看板' : '仅 API'} · 状态文件 ${daemon.file}`);
  log(`登录自启动：${autostart.enabled ? '已开启' : '未开启'}（${autostart.mechanism}）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';

  if (args['dsh-app']) process.env.DSH_DELEGATE_APP = String(args['dsh-app']);

  if (args.version || command === '--version' || command === '-v') {
    log(pkg.version);
    return;
  }
  if (command === 'serve') {
    require('../lib/mcp').serve();
    return;
  }
  assertKnownFlags(command, args);
  if (command === 'install') return commandInstall(args);
  if (command === 'uninstall') return commandUninstall(args);
  if (command === 'doctor') return commandDoctor(args);
  if (command === 'print-config') return commandPrintConfig();
  if (command === 'ui') return commandUi(args);
  if (command === 'daemon' || command === 'service') return commandDaemon(args);
  if (command === 'autostart') return commandAutostart(args);
  if (command === 'retry') return commandRetry(args);
  if (command === 'status') return commandStatus();
  if (command === 'statusline') return commandStatusline();
  if (command === 'hook') return commandHook(args);
  if (command === 'quota') return commandQuota();

  log(`dsh-delegate ${pkg.version} — 让 Claude / Codex 把简单任务派给本机 DeepSeek Harness

用法：
  dsh-delegate install [--targets=claude-desktop,claude-code,codex] [--dry-run] [--copy-credentials] [--autostart] [--usage-hooks]
  dsh-delegate quota                                     # Claude / Codex 额度和当前派活档位
  dsh-delegate retry [--limit=8] [--concurrency=2] [--id=run-...]   # 继续失败的任务
  dsh-delegate statusline | hook prompt                  # Claude Code 的 statusLine / UserPromptSubmit（--usage-hooks 配好）
  dsh-delegate daemon [--port=7788] [--no-ui] [--open]   # 常驻服务（可选是否带看板）
  dsh-delegate ui [--port=7788] [--open]                 # daemon + 看板（--open 顺便打开浏览器）
  dsh-delegate autostart on|off|status [--port=7788]     # 登录自启动（默认仅 API）
  dsh-delegate status
  dsh-delegate doctor [--run]
  dsh-delegate print-config
  dsh-delegate uninstall [--remove-runtime] [--keep-clients]
  dsh-delegate serve                                     # MCP stdio server（客户端拉起）

全局：
  --dsh-app="C:\\Path\\To\\DSH NEXT.exe"    # 手动指定桌面版位置

可执行文件（安装后）：dsh --profile headless "<任务>"
`);
}

Promise.resolve(main()).catch((cause) => {
  process.stderr.write(`dsh-delegate: ${cause && cause.message ? cause.message : cause}\n`);
  process.exitCode = 1;
});
