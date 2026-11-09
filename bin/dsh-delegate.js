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
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of ['lib', 'assets', 'bin']) {
    const from = path.join(ROOT, entry);
    const to = path.join(dest, entry);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  for (const file of ['package.json']) {
    fs.copyFileSync(path.join(ROOT, file), path.join(dest, file));
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

function commandInstall(args) {
  const dryRun = Boolean(args['dry-run']);
  const launch = dsh.discover();
  const ctx = runtimeContext();

  log(`DSH: ${launch.kind === 'desktop' ? '桌面版' : 'CLI'} — ${launch.detail}`);
  log(`运行时目录: ${bridgeDir()}${dryRun ? '（dry-run，不写入）' : ''}`);
  log('');

  if (!dryRun) copyRuntime(bridgeDir());

  const results = [];
  results.push({ what: 'shim', ...agents.installShim(launch, ctx.dshHome, { dryRun }) });
  for (const item of agents.installSkill(ctx.dshHome, { dryRun })) results.push({ what: 'skill', ...item });
  for (const item of agents.installInstructions(ctx.dshHome, { dryRun })) results.push({ what: 'instructions', ...item });

  if (!args['no-clients']) {
    for (const item of targets.applyAll(parseTargets(args.targets), ctx, { dryRun })) {
      results.push({ what: `client:${item.target}`, ...item });
    }
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';

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

  log(`dsh-delegate ${pkg.version} — 让 Claude / Codex 把简单任务派给本机 DeepSeek Harness

用法：
  dsh-delegate install [--targets=claude-desktop,claude-code,codex] [--dry-run] [--copy-credentials]
  dsh-delegate doctor [--run]
  dsh-delegate print-config
  dsh-delegate uninstall [--remove-runtime]
  dsh-delegate serve                 # MCP stdio server（一般由客户端拉起）

可执行文件（安装后）：dsh --profile headless "<任务>"
`);
}

Promise.resolve(main()).catch((cause) => {
  process.stderr.write(`dsh-delegate: ${cause && cause.message ? cause.message : cause}\n`);
  process.exitCode = 1;
});
