'use strict';

/**
 * DSH discovery + headless execution.
 * Zero dependencies; works on Windows and POSIX.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Live worker processes, so the MCP server can clean up on exit. */
const liveChildren = new Set();

function killAll() {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  liveChildren.clear();
}

function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return process.env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function which(command) {
  const exts =
    process.platform === 'win32'
      ? ['.cmd', '.exe', '.bat', '.ps1', '']
      : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!exists(candidate)) continue;
      if (isOwnShim(candidate)) continue; // never re-point the launcher at itself
      return candidate;
    }
  }
  return null;
}

/** Our generated launcher carries this marker; discovery must skip it. */
function isOwnShim(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    return head.includes('dsh-delegate shim') || /ELECTRON_RUN_AS_NODE/.test(head);
  } catch {
    return false;
  }
}

/** Desktop app candidates: exe path + resources/app.asar/lib/desktop-cli.js. */
function desktopCandidates() {
  const list = [];
  const add = (exe, resourcesDir) => list.push({ exe, bootstrap: path.join(resourcesDir, 'lib', 'desktop-cli.js') });

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env['ProgramW6432'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    ].filter(Boolean);
    const names = ['DSH NEXT', 'DSH', 'DeepSeek Harness'];
    for (const root of roots) {
      for (const name of names) {
        const dir = path.join(root, name);
        add(path.join(dir, `${name}.exe`), path.join(dir, 'resources', 'app.asar'));
      }
    }
  } else if (process.platform === 'darwin') {
    for (const name of ['DSH NEXT', 'DSH', 'DeepSeek Harness']) {
      const app = path.join('/Applications', `${name}.app`);
      add(
        path.join(app, 'Contents', 'MacOS', name),
        path.join(app, 'Contents', 'Resources', 'app.asar'),
      );
    }
  } else {
    for (const name of ['dsh-next', 'dsh-desktop']) {
      const dir = path.join('/opt', name);
      add(path.join(dir, name), path.join(dir, 'resources', 'app.asar'));
    }
  }
  return list;
}

/**
 * Last resort: scan install roots for any app directory that ships an
 * `app.asar`, so unusual install locations still work.
 */
function scannedCandidates() {
  const list = [];
  const pushDir = (dir) => {
    const resources = path.join(dir, 'resources', 'app.asar');
    if (!fs.existsSync(resources)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const exe = entries.find((entry) => entry.toLowerCase().endsWith('.exe'));
    if (exe) list.push({ exe: path.join(dir, exe), bootstrap: path.join(resources, 'lib', 'desktop-cli.js') });
  };

  const roots =
    process.platform === 'win32'
      ? [
          process.env['ProgramFiles'],
          process.env['ProgramFiles(x86)'],
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
        ].filter(Boolean)
      : process.platform === 'darwin'
        ? ['/Applications']
        : ['/opt', '/usr/local/lib', path.join(os.homedir(), '.local', 'share')];

  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (entry.name.toLowerCase().endsWith('.app')) {
        const macos = path.join(dir, 'Contents', 'MacOS');
        const resources = path.join(dir, 'Contents', 'Resources', 'app.asar');
        if (fs.existsSync(resources) && fs.existsSync(macos)) {
          const exe = fs.readdirSync(macos)[0];
          if (exe) list.push({ exe: path.join(macos, exe), bootstrap: path.join(resources, 'lib', 'desktop-cli.js') });
        }
        continue;
      }
      pushDir(dir);
    }
  }
  return list;
}

/**
 * Resolve how to start DSH.
 * @returns {{kind:'desktop'|'cli', command:string, argsPrefix:string[], detail:string}}
 */
function discover() {
  const explicitApp = process.env.DSH_DELEGATE_APP;
  const explicitBootstrap = process.env.DSH_DELEGATE_BOOTSTRAP;
  if (explicitApp) {
    return {
      kind: 'desktop',
      command: explicitApp,
      argsPrefix: ['--expose-internals', explicitBootstrap || ''],
      detail: `env DSH_DELEGATE_APP=${explicitApp}`,
    };
  }

  for (const candidate of [...desktopCandidates(), ...scannedCandidates()]) {
    if (exists(candidate.exe)) {
      return {
        kind: 'desktop',
        command: candidate.exe,
        argsPrefix: ['--expose-internals', candidate.bootstrap],
        detail: candidate.exe,
      };
    }
  }

  const cli = which('dsh');
  if (cli) {
    return { kind: 'cli', command: cli, argsPrefix: [], detail: cli };
  }

  const error = new Error(
    '找不到 DSH：既没有桌面版安装，也没有 PATH 上的 dsh 命令。\n' +
      '  设置 DSH_DELEGATE_APP=/path/to/DSH NEXT(.exe) 指向桌面版可执行文件，或安装 @deepseek-ai/dsh。',
  );
  error.code = 'DSH_NOT_FOUND';
  throw error;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (text === '') return '""';
  return /[\s"^&|<>()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Spawn DSH, handling Windows .cmd shims without a shell-injection surface. */
function spawnDsh(launch, args, options) {
  const isCmd = /\.(cmd|bat)$/i.test(launch.command);
  if (process.platform === 'win32' && isCmd) {
    const line = [quoteCmdArg(launch.command), ...args.map(quoteCmdArg)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], options);
  }
  return spawn(launch.command, args, options);
}

function installCommand(launch) {
  if (!launch) return null;
  if (launch.kind === 'desktop') {
    const quote = process.platform === 'win32' ? '"' : "'";
    return `${quote}${launch.command}${quote} --expose-internals ${quote}${launch.argsPrefix[1]}${quote} --profile headless`;
  }
  return `${launch.command} --profile headless`;
}

/** Extra header the worker reads: it declares the single writable root. */
function scopeBlock(scopeAbs, rootAbs, relScope) {
  return [
    '[工作区约束]',
    `· 你的工作目录，也是唯一可写的根：${scopeAbs}`,
    `· 仓库根：${rootAbs}（只读：可以随意读取、搜索、看别人的改动，但写会被沙箱拒绝）`,
    `· 只能修改 ${relScope} 内的文件。写其它位置会返回 [sandbox: file access denied]，不要重试，也不要绕过。`,
    '· 需要在仓库根跑命令时用绝对路径或 -C 参数，不要 cd 出工作目录。',
    '· 不要执行 git commit / push / 改 .git —— 提交由上层做。',
    '· 最后如实报告：你改了哪些文件（相对仓库根）、跑了哪些检查、退出码。',
  ].join('\n');
}

/**
 * Run one headless task.
 * @param {object} input
 * @param {string} input.task
 * @param {string} [input.cwd]
 * @param {string} [input.writeScope] relative subdirectory of cwd = the only writable root
 * @param {string} [input.sessionId]
 * @param {'workspace-write'|'danger-full-access'} [input.permissionMode]
 * @param {'never'|'ask'} [input.approvalPolicy]
 * @param {number} [input.timeoutMs]
 */
function runTask(input) {
  const started = Date.now();
  const opts = input || {};

  return new Promise((resolve) => {
    const fail = (message) =>
      resolve({
        ok: false,
        durationMs: Date.now() - started,
        code: null,
        sessionId: '',
        text: '',
        reason: message,
        stderrTail: '',
        permissionMode: opts.permissionMode || 'workspace-write',
        scope: '',
        cwd: opts.cwd || process.cwd(),
      });

    const task = String(opts.task || '');
    if (task.trim().length === 0) return fail('task 不能为空。');

    let launch;
    try {
      launch = opts.launch || discover();
    } catch (cause) {
      return fail(cause.message);
    }

    const rootCwd = path.resolve(process.cwd(), opts.cwd || '.');
    if (!isDir(rootCwd)) return fail(`工作目录不存在或不是目录：${rootCwd}`);

    let cwd = rootCwd;
    let scopeRel = '';
    let scopeAbs = '';
    if (opts.writeScope) {
      scopeAbs = path.resolve(rootCwd, String(opts.writeScope));
      const rel = path.relative(rootCwd, scopeAbs);
      if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
        return fail(`write_scope 必须是 ${rootCwd} 内的子目录，收到：${opts.writeScope}`);
      }
      if (!isDir(scopeAbs)) {
        return fail(`write_scope 目录不存在：${scopeAbs}（先创建它，或换一个已存在的目录）`);
      }
      cwd = scopeAbs;
      scopeRel = rel.split(path.sep).join('/');
    }

    const permissionMode = opts.permissionMode || 'workspace-write';
    const approvalPolicy = opts.approvalPolicy || 'never';
    const timeoutMs = Math.min(
      Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    const args = [
      ...launch.argsPrefix,
      '--profile',
      'headless',
      '--json',
      '--permission-mode',
      permissionMode,
      '--approval-policy',
      approvalPolicy,
    ];
    if (opts.sessionId) args.push('--session-id', String(opts.sessionId));
    args.push('-');

    const env = { ...process.env, DSH_HOME: dshHome() };
    if (launch.kind === 'desktop') env.ELECTRON_RUN_AS_NODE = '1';

    let child;
    try {
      child = spawnDsh(launch, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      return fail(`启动 DSH 失败：${cause && cause.message ? cause.message : cause}`);
    }

    let stdout = '';
    let streamBuffer = '';
    let stderr = '';
    let settled = false;
    let sessionId = '';
    let finalText = '';
    let finalReason = null;
    let streamError = '';

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      for (const event of events) {
        if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
        if (event.type === 'final') {
          if (typeof event.text === 'string') finalText = event.text;
          if (event.reason) finalReason = event.reason;
          if (typeof event.sessionId === 'string') sessionId = event.sessionId;
        }
        if (event.type === 'error' && typeof event.message === 'string') streamError = event.message;
      }

      const ok = code === 0 && finalReason !== null && finalReason.kind === 'completed';
      const reason =
        streamError ||
        (finalReason && finalReason.kind === 'error' && finalReason.error
          ? `${finalReason.error.code || 'ERROR'}: ${finalReason.error.message || ''}`
          : '');

      let usage = null;
      try {
        const usageLib = require('./usage');
        usage = usageLib.withSpeed(usageLib.summarize(sessionId), Date.now() - started);
      } catch {
        usage = null;
      }

      resolve({
        ok,
        usage,
        durationMs: Date.now() - started,
        code,
        sessionId,
        text: finalText,
        reason,
        stderrTail: stderr
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .slice(-10)
          .join('\n'),
        permissionMode,
        scope: scopeRel,
        cwd,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        durationMs: Date.now() - started,
        code: 'timeout',
        sessionId,
        text: '',
        reason: `超过 ${timeoutMs}ms 未结束，已终止。`,
        stderrTail: '',
        permissionMode,
        scope: scopeRel,
        cwd,
      });
    }, timeoutMs + 5000);

    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        durationMs: Date.now() - started,
        code: 'spawn-error',
        sessionId: '',
        text: '',
        reason: `启动 DSH 失败：${cause && cause.message ? cause.message : cause}`,
        stderrTail: '',
        permissionMode,
        scope: scopeRel,
        cwd,
      });
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
      if (typeof opts.onEvent === 'function') {
        // Stream newline-delimited events as they arrive, so the MCP layer can
        // forward progress while the worker is still running.
        streamBuffer += text;
        let index = streamBuffer.indexOf('\n');
        while (index !== -1) {
          const line = streamBuffer.slice(0, index).trim();
          streamBuffer = streamBuffer.slice(index + 1);
          if (line.length > 0) {
            try {
              opts.onEvent(JSON.parse(line));
            } catch {
              /* partial or non-JSON line: ignore */
            }
          }
          index = streamBuffer.indexOf('\n');
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
    });

    liveChildren.add(child);
    child.on('close', (code) => {
      liveChildren.delete(child);
      finish(code === null ? 'killed' : code);
    });

    const taskText = scopeRel ? `${scopeBlock(scopeAbs, rootCwd, scopeRel)}\n\n${task}` : task;
    try {
      child.stdin.end(taskText, 'utf8');
    } catch {
      /* close/error handler reports it */
    }
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  dshHome,
  discover,
  installCommand,
  runTask,
  mapLimit,
  killAll,
  which,
  exists,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
