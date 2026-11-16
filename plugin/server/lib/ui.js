'use strict';

/**
 * Local configuration UI: a tiny HTTP server on 127.0.0.1 serving one page.
 * Lets you pick provider / model / reasoning effort, store API keys in
 * $DSH_HOME/.env, run a live smoke task, and re-wire client configs.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const config = require('./config');
const dsh = require('./dsh');
const targets = require('./targets');
const runlog = require('./runlog');

function page() {
  return fs.readFileSync(path.join(__dirname, '..', 'assets', 'ui.html'), 'utf8');
}

/*
 * Who may talk to this service. It can run DSH tasks, rewrite client configs and
 * store API keys, so a web page must never reach it: any site could otherwise
 * POST to 127.0.0.1 from the user's browser.
 *   - Host must be a loopback name (defeats DNS rebinding).
 *   - A browser Origin must be a loopback page (the dashboard itself, `dsh web`)
 *     or the DSH desktop app, which serves its UI from the custom scheme
 *     dsh-app:// — a scheme no web page can claim as its origin.
 *     Extra origins: DSH_DELEGATE_ALLOWED_ORIGINS=origin1,origin2
 *   - No Origin = curl / scripts / plain navigation, i.e. local processes.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const APP_SCHEMES = new Set(['dsh-app:']);

function hostAllowed(host) {
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function originAllowed(origin) {
  if (!origin) return true;
  const extra = String(process.env.DSH_DELEGATE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (APP_SCHEMES.has(url.protocol)) return true;
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname);
  } catch {
    return false; // includes the opaque origin "null"
  }
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders(res.corsOrigin),
  });
  res.end(payload);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(httpError(413, '请求体过大'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      // A JSON content type forces a CORS preflight for cross-origin callers.
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return reject(httpError(415, '请求体必须是 application/json'));
      }
      try {
        resolve(JSON.parse(raw));
      } catch (cause) {
        reject(httpError(400, `JSON 解析失败：${cause.message}`));
      }
    });
    req.on('error', reject);
  });
}

function clientState() {
  const desktop = targets.claudeDesktopConfigs();
  const codex = targets.codexConfigPath();
  const claudeJson = targets.claudeCodeConfigPath();
  const has = (file) => {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Boolean(json.mcpServers && json.mcpServers[targets.SERVER_NAME]);
    } catch {
      return false;
    }
  };
  return {
    'claude-desktop': { file: desktop[0] || null, configured: desktop.length > 0 && has(desktop[0]) },
    'claude-code': { file: claudeJson, configured: fs.existsSync(claudeJson) && has(claudeJson) },
    codex: {
      file: codex,
      configured: fs.existsSync(codex) && /\[mcp_servers\.dsh\]/.test(fs.readFileSync(codex, 'utf8')),
    },
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/state' && req.method === 'GET') {
    let launch = null;
    let launchError = null;
    try {
      launch = dsh.discover();
    } catch (cause) {
      launchError = cause.message;
    }
    return json(res, 200, {
      dsh: { launch, launchError, node: process.version, platform: process.platform },
      config: config.state(),
      clients: clientState(),
      launcher: launch ? dsh.installCommand(launch) : null,
    });
  }

  if (pathname === '/api/runs' && req.method === 'GET') {
    const raw = new URL(req.url, 'http://127.0.0.1').searchParams.get('limit');
    const asked = raw === null ? NaN : Number(raw);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.floor(asked), 1), 500) : 20;
    const runs = runlog.listRuns(limit);
    const totals = runs.reduce(
      (acc, run) => {
        if (run.usage) {
          acc.input += run.usage.input || 0;
          acc.output += run.usage.output || 0;
          acc.total += run.usage.total || 0;
          acc.wallMs += run.usage.wallMs || 0;
          acc.runs += 1;
        }
        return acc;
      },
      { input: 0, output: 0, total: 0, wallMs: 0, runs: 0 },
    );
    totals.outputPerSecond = totals.wallMs
      ? Math.round((totals.output / (totals.wallMs / 1000)) * 10) / 10
      : 0;
    return json(res, 200, {
      runs,
      running: runs.filter((run) => run.state === 'running').length,
      storage: runlog.storageInfo(),
      totals,
    });
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const id = pathname.slice('/api/runs/'.length);
    const meta = runlog.readMeta(id);
    if (!meta) return json(res, 404, { error: '找不到该运行记录' });
    return json(res, 200, { run: meta, events: runlog.readEvents(id, 200) });
  }

  if (pathname === '/api/runs/retry' && req.method === 'POST') {
    const body = await readBody(req);
    const resume = require('./resume');
    // 按 session id 直接续接（恢复清单里的任务可能已经找不到原运行记录）
    if (Array.isArray(body.sessions) && body.sessions.length) {
      const metas = body.sessions
        .filter((item) => item && /^[A-Za-z0-9._:-]+$/.test(String(item.sessionId || '')))
        .map((item) => ({
          id: 'manual:' + item.sessionId,
          title: item.title || '手动续接',
          cwd: item.cwd,
          sessionId: item.sessionId,
          state: 'failed',
          reason: 'manual',
        }));
      resume
        .resumeMany(metas, { concurrency: Number(body.concurrency) || 2, task: body.task })
        .catch(() => {});
      return json(res, 200, { ok: true, started: metas.map((m) => ({ id: m.id, title: m.title })), skipped: [] });
    }
    const { candidates, skipped } = resume.pickCandidates({
      ids: Array.isArray(body.ids) ? body.ids : null,
      limit: Number.isFinite(body.limit) ? body.limit : 8,
      force: body.force === true,
    });
    if (!candidates.length) {
      return json(res, 200, { ok: true, resumed: [], skipped, message: '没有可继续的任务' });
    }
    // Long jobs: start them and return immediately; the board follows them.
    resume
      .resumeMany(candidates, { concurrency: Number(body.concurrency) || 2, task: body.task })
      .catch(() => {});
    return json(res, 200, {
      ok: true,
      started: candidates.map((run) => ({ id: run.id, title: run.title })),
      skipped,
    });
  }

  if (pathname === '/api/quota' && req.method === 'GET') {
    return json(res, 200, require('./quota').summary());
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return json(res, 200, { ok: true, settings: config.readSettings(), file: config.state().settingsFile });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const settings = config.writeSettings(body);
      return json(res, 200, { ok: true, settings });
    } catch (cause) {
      return json(res, 400, { ok: false, error: cause.message });
    }
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const catalogs = await require('./models').load(url.searchParams.get('refresh') === '1');
      return json(res, 200, catalogs);
    } catch (cause) {
      return json(res, 500, { error: cause.message });
    }
  }

  if (pathname === '/api/service' && req.method === 'GET') {
    const daemon = require('./daemon').status();
    const autostart = require('./autostart').status();
    return json(res, 200, {
      running: daemon.running,
      pid: daemon.pid || null,
      port: daemon.port || config.readSettings().daemonPort,
      ui: daemon.ui !== undefined ? daemon.ui : null,
      url: daemon.url || null,
      stateFile: daemon.file,
      autostart,
      settings: {
        daemonPort: config.readSettings().daemonPort,
        daemonUi: config.readSettings().daemonUi,
        daemonAutostart: config.readSettings().daemonAutostart,
      },
    });
  }

  if (pathname === '/api/service' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = config.writeSettings(body);
    const autostart = settings.daemonAutostart
      ? require('./autostart').enable({ port: settings.daemonPort })
      : require('./autostart').disable();
    const daemon = require('./daemon').status();
    const restartRequired = Boolean(
      daemon.running && (daemon.port !== settings.daemonPort || Boolean(daemon.ui) !== Boolean(settings.daemonUi)),
    );
    return json(res, 200, { ok: true, settings, autostart, restartRequired, running: daemon.running });
  }

  if (pathname === '/api/service/restart' && req.method === 'POST') {
    const settings = config.readSettings();
    const { spawn } = require('node:child_process');
    const cli = path.join(__dirname, '..', 'bin', 'dsh-delegate.js');
    const args = [cli, 'daemon', `--port=${settings.daemonPort}`];
    if (!settings.daemonUi) args.push('--no-ui');
    try {
      spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (cause) {
      return json(res, 500, { ok: false, error: `重启失败：${cause.message}` });
    }
    json(res, 200, { ok: true, restarted: true, port: settings.daemonPort, ui: settings.daemonUi });
    setTimeout(() => process.exit(0), 400).unref?.();
    return undefined;
  }

  if (pathname === '/api/model' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const next = config.writeModel(body);
      return json(res, 200, { ok: true, model: next });
    } catch (cause) {
      return json(res, 400, { ok: false, error: cause.message });
    }
  }

  if (pathname === '/api/model/reset' && req.method === 'POST') {
    return json(res, 200, { ok: true, model: config.clearModel() });
  }

  if (pathname === '/api/env' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      return json(res, 200, { ok: true, env: config.writeEnvKey(body.name, body.value) });
    } catch (cause) {
      return json(res, 400, { ok: false, error: cause.message });
    }
  }

  if (pathname === '/api/provider/install' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await config.installProvider(body.id);
      return json(res, 200, { ok: true, ...result });
    } catch (cause) {
      return json(res, 400, { ok: false, error: cause.message });
    }
  }

  if (pathname === '/api/clients/install' && req.method === 'POST') {
    const ctx = {
      nodePath: process.execPath,
      mcpPath: path.join(dsh.dshHome(), 'bridge', 'lib', 'mcp.js'),
      dshHome: dsh.dshHome(),
    };
    const results = targets.applyAll(['claude-desktop', 'claude-code', 'codex'], ctx, { dryRun: false });
    return json(res, 200, { ok: true, results });
  }

  if (pathname === '/api/test' && req.method === 'POST') {
    const body = await readBody(req);
    const task = String(body.task || '').trim() || '只回复两个字：可用';
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const write = (value) => res.write(`${JSON.stringify(value)}\n`);
    const run = runlog.createRun({ kind: 'test', title: task.slice(0, 60), cwd: body.cwd || process.cwd() });
    const result = await dsh.runTask({
      task,
      cwd: body.cwd || undefined,
      timeoutMs: 300_000,
      onEvent: (event) => {
        if (event.type === 'tool_call') {
          const input = event.input || {};
          const detail = input.command || input.path || input.query || '';
          runlog.append(run, { kind: 'tool', name: event.name || event.tool, detail: String(detail).slice(0, 160) });
          write({ kind: 'tool', name: event.name || event.tool, args: event.input || {} });
        } else if (event.type === 'status' && event.phase === 'turn_start') {
          runlog.append(run, { kind: 'turn', turn: event.turn });
          write({ kind: 'turn', turn: event.turn });
        } else if (event.type === 'tool_result') {
          runlog.append(run, {
            kind: 'result',
            status: event.status || 'completed',
            text: String(event.result === undefined ? '' : event.result).slice(0, 4000),
          });
        } else if (event.type === 'text' && typeof event.text === 'string' && event.text.trim()) {
          runlog.append(run, { kind: 'text', text: event.text.slice(0, 4000) });
        } else if (event.type === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
          runlog.append(run, { kind: 'thinking', text: event.text.slice(0, 4000) });
        }
      },
    });
    runlog.finish(run, {
      ok: result.ok,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      text: result.text,
      reason: result.reason,
      usage: result.usage,
    });
    write({ kind: 'final', ok: result.ok, text: result.text, reason: result.reason, durationMs: result.durationMs });
    res.end();
    return undefined;
  }

  return json(res, 404, { error: 'not found' });
}

/**
 * @param {{port?:number, serveUi?:boolean, strictPort?:boolean}} options
 *   strictPort: fail on EADDRINUSE instead of moving to the next port. The service
 *   needs its configured port: the DSH panel and the dashboard link look there.
 */
function start(options = {}) {
  const base = Number.isFinite(options.port) && options.port > 0 ? options.port : 7788;
  const serveUi = options.serveUi !== false;
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, serveUi);
    } catch (cause) {
      // A malformed request (e.g. a URL `new URL()` rejects) must not take the service down.
      try {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
      } catch {
        /* socket already gone */
      }
    }
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const listen = (port) => {
      server.once('error', (cause) => {
        if (cause.code === 'EADDRINUSE' && !options.strictPort && attempt < 10) {
          attempt += 1;
          listen(base + attempt);
          return;
        }
        reject(cause);
      });
      server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${port}` }));
    };
    listen(base);
  });
}

function handleRequest(req, res, serveUi) {
  const origin = req.headers.origin;
  if (!hostAllowed(req.headers.host)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden: host');
    return;
  }
  if (!originAllowed(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden: origin');
    return;
  }
  res.corsOrigin = origin || null;

  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!serveUi) {
      json(res, 200, {
        name: 'dsh-delegate',
        mode: 'api-only',
        ui: false,
        endpoints: ['/api/state', '/api/model', '/api/settings', '/api/env', '/api/runs', '/api/quota', '/api/test', '/api/clients/install'],
        hint: '这是仅 API 模式；用 dsh-delegate daemon（不带 --no-ui）启动看板。',
      });
      return;
    }
    const html = page();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname).catch((cause) => {
      if (!res.headersSent) json(res, cause.status || 500, { ok: false, error: cause.message });
      else res.end();
    });
    return;
  }
  res.writeHead(404).end('not found');
}

module.exports = { start };
