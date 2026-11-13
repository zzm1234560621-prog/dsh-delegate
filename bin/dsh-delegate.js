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
      const [key, value] = token.slice(2).split('=');
      args[key] = value === undefined ? true : value;
    } else {
      args._.push(token);
    }
  }
  return args;
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
  try {
    for (const entry of ['lib', 'assets', 'bin']) {
      fs.cpSync(path.join(ROOT, entry), path.join(stage, entry), { recursive: true });
    }
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));

    const backup = `${dest}.old-${process.pid}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, backup);
    fs.renameSync(stage, dest);
    fs.rmSync(backup, { recursive: true, force: true });
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

  if (args.autostart && !dryRun) {
    const result = require('../lib/autostart').enable({ port: Number(args.port) || 7788 });
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
      log('⚠ 没检测到凭据：headless 只读 $DSH_HOME/.env 或启动环境，不读 GUI 保存的 key。');
      log('  第一次派活会报 MISSING_CREDENTIAL。补一个即可：');
      log(`    "DEEPSEEK_API_KEY=sk-..." | Add-Content "${envFile}"`);
      log('  或重跑本命令时加 --copy-credentials（从 DSH 已有凭据里搬）。');
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
  const removed = [];
  removed.push({ what: 'shim', ...agents.removeShim() });
  for (const item of agents.removeSkill(dsh.dshHome())) removed.push({ what: 'skill', ...item });
  for (const item of agents.removeInstructions(dsh.dshHome())) removed.push({ what: 'instructions', ...item });
  log('已移除 agent 侧文件（客户端配置里的 dsh 条目需要手动删，或按 README 的说明操作）：');
  for (const item of removed) log(`  ${item.what.padEnd(14)} ${item.status.padEnd(10)} ${item.file}`);
  if (args['remove-runtime']) {
    fs.rmSync(bridgeDir(), { recursive: true, force: true });
    log(`已删除运行时目录 ${bridgeDir()}`);
  }
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
    detail: fs.existsSync(path.join(home, '.env')) ? 'present' : '缺少；用 install --copy-credentials 或写 DEEPSEEK_API_KEY',
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

function commandPrintConfig() {
  const ctx = runtimeContext();
  log(
    JSON.stringify(
      {
        claude_desktop: { mcpServers: { [targets.SERVER_NAME]: { command: ctx.nodePath, args: [ctx.mcpPath], env: { DSH_HOME: ctx.dshHome } } } },
        codex_toml: `[mcp_servers.${targets.SERVER_NAME}]\ncommand = "${ctx.nodePath}"\nargs = ["${ctx.mcpPath}"]\nenv = { DSH_HOME = "${ctx.dshHome}" }`,
        launch: dsh.installCommand(dsh.discover()),
      },
      null,
      2,
    ),
  );
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
  const { url } = await daemon.run({ port, ui: withUi });
  if (withUi && args.open) openBrowser(url);
  // keep the process alive: daemon.run returns after the server starts
  await new Promise(() => {});
}

function commandAutostart(args) {
  const action = args._[1] || 'status';
  const autostart = require('../lib/autostart');
  const port = Number(args.port) || 7788;
  if (action === 'on') {
    const result = autostart.enable({ port });
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

function commandStatus() {
  const daemon = require('../lib/daemon').status();
  const autostart = require('../lib/autostart').status();
  log(`服务：${daemon.running ? `运行中 ${daemon.url}` : '未运行'}`);
  if (daemon.running) log(`  pid ${daemon.pid} · ${daemon.ui ? 'API + 看板' : '仅 API'} · 状态文件 ${daemon.file}`);
  log(`登录自启动：${autostart.enabled ? '已开启' : '未开启'}（${autostart.mechanism}）`);
}

function main() {
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
  if (command === 'install') return commandInstall(args);
  if (command === 'uninstall') return commandUninstall(args);
  if (command === 'doctor') return commandDoctor(args);
  if (command === 'print-config') return commandPrintConfig();
  if (command === 'ui') return commandUi(args);
  if (command === 'daemon' || command === 'service') return commandDaemon(args);
  if (command === 'autostart') return commandAutostart(args);
  if (command === 'status') return commandStatus();

  log(`dsh-delegate ${pkg.version} — 让 Claude / Codex 把简单任务派给本机 DeepSeek Harness

用法：
  dsh-delegate install [--targets=claude-desktop,claude-code,codex] [--dry-run] [--copy-credentials] [--autostart]
  dsh-delegate daemon [--port=7788] [--no-ui] [--open]   # 常驻服务（可选是否带看板）
  dsh-delegate ui [--port=7788] [--open]                 # daemon + 看板 + 打开浏览器
  dsh-delegate autostart on|off|status [--port=7788]     # 登录自启动（默认仅 API）
  dsh-delegate status
  dsh-delegate doctor [--run]
  dsh-delegate print-config
  dsh-delegate uninstall [--remove-runtime]
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
