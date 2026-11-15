'use strict';

/**
 * Append-only run log so the local UI can watch subagents the MCP server
 * started in another process.
 *
 * Layout (under $DSH_HOME/delegate-runs):
 *   <id>.json    metadata + final state
 *   <id>.jsonl   event stream (one JSON object per line)
 *
 * A run started for an MCP job carries `jobId` (plus `jobIndex` / `jobTotal` for each
 * subagent of a dsh_parallel batch) and, once finished, the full `result`, so dsh_job
 * can still answer after the MCP server restarted. States: running, done, failed,
 * interrupted (the server went away mid-run and said so).
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { dshHome } = require('./dsh');
const { readSettings } = require('./config');

function dir() {
  return path.join(dshHome(), 'delegate-runs');
}

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true });
  return dir();
}

function nextId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function metaFile(id) {
  return path.join(dir(), `${id}.json`);
}

function eventsFile(id) {
  return path.join(dir(), `${id}.jsonl`);
}

function writeMeta(id, meta) {
  fs.writeFileSync(metaFile(id), `${JSON.stringify(meta, null, 2)}\n`);
}

function createRun(meta) {
  ensureDir();
  const id = nextId();
  const record = {
    id,
    kind: meta.kind || 'task',
    title: meta.title || '子代理',
    cwd: meta.cwd || process.cwd(),
    pid: process.pid,
    startedAt: Date.now(),
    state: 'running',
    toolCalls: 0,
    tasks: meta.tasks || null,
  };
  if (meta.jobId) {
    record.jobId = meta.jobId;
    if (Number.isInteger(meta.jobIndex)) {
      record.jobIndex = meta.jobIndex; // 0-based position in the dsh_parallel batch
      record.jobTotal = meta.jobTotal;
    }
  }
  writeMeta(id, record);
  fs.writeFileSync(eventsFile(id), '');
  return record;
}

/** Merge fields into a live run's metadata, e.g. the session id as soon as DSH reports it. */
function update(record, patch) {
  if (!record || record.closed) return;
  Object.assign(record, patch);
  try {
    writeMeta(record.id, { ...readMeta(record.id), ...patch });
  } catch {
    /* logging must never break a run */
  }
}

function append(record, event) {
  if (!record) return;
  try {
    fs.appendFileSync(eventsFile(record.id), `${JSON.stringify({ t: Date.now(), ...event })}\n`);
    if (event.kind === 'tool') {
      record.toolCalls = (record.toolCalls || 0) + 1;
      record.lastNote = `${event.name || 'tool'}${event.detail ? `：${String(event.detail).slice(0, 60)}` : ''}`;
    } else if (event.kind === 'text') {
      record.lastNote = String(event.text || '').slice(0, 80);
    } else if (event.kind === 'turn') {
      record.lastNote = `第 ${event.turn} 轮`;
    }
  } catch {
    /* logging must never break a run */
  }
}

const RESULT_TEXT_LIMIT = 200_000;

function finish(record, summary) {
  if (!record || record.closed) return; // finished or interrupted already
  record.closed = true;
  const meta = {
    ...readMeta(record.id),
    state: summary.ok ? 'done' : 'failed',
    endedAt: Date.now(),
    durationMs: summary.durationMs,
    sessionId: summary.sessionId || record.sessionId || null,
    reason: summary.reason || null,
    text: summary.text ? String(summary.text).slice(0, 4000) : '',
    toolCalls: record.toolCalls || 0,
    usage: summary.usage || null,
  };
  if (summary.result) {
    // The whole runTask() outcome: `text` above is only a preview for the dashboard.
    const full = String(summary.result.text || '');
    meta.result = {
      ...summary.result,
      text:
        full.length > RESULT_TEXT_LIMIT
          ? `${full.slice(0, RESULT_TEXT_LIMIT)}\n…（运行记录只保留了前 ${RESULT_TEXT_LIMIT} 个字符）`
          : full,
    };
  }
  try {
    writeMeta(record.id, meta);
  } catch {
    /* ignore */
  }
  compressEvents(record.id);
  prune();
}

/**
 * A run that will never finish: its MCP server is shutting down and its worker dies
 * with it. Synchronous on purpose, it runs right before the process exits.
 */
function interrupt(record, reason) {
  if (!record || record.closed) return;
  record.closed = true;
  const endedAt = Date.now();
  try {
    writeMeta(record.id, {
      ...readMeta(record.id),
      state: 'interrupted',
      endedAt,
      durationMs: endedAt - (record.startedAt || endedAt),
      reason: reason || '运行被中断',
      toolCalls: record.toolCalls || 0,
    });
  } catch {
    /* ignore */
  }
  compressEvents(record.id);
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
  } catch {
    return null;
  }
}

function eventsZstdFile(id) {
  return `${eventsFile(id)}.zstd`;
}

/** Read a run's events: live plain JSONL, or the compressed archive once done. */
function readEvents(id, limit = 200) {
  let text = '';
  try {
    if (fs.existsSync(eventsFile(id))) {
      text = fs.readFileSync(eventsFile(id), 'utf8');
    } else if (fs.existsSync(eventsZstdFile(id))) {
      text = zlib.zstdDecompressSync(fs.readFileSync(eventsZstdFile(id))).toString('utf8');
    }
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Same technique the harness uses for sessions: JSONL compressed with zstd at rest. */
function compressEvents(id) {
  const plain = eventsFile(id);
  if (!fs.existsSync(plain)) return;
  try {
    const raw = fs.readFileSync(plain);
    // Keep tiny runs uncompressed: a frame header would cost more than it saves.
    if (raw.length > 512) {
      fs.writeFileSync(eventsZstdFile(id), zlib.zstdCompressSync(raw));
      fs.rmSync(plain, { force: true });
    }
  } catch {
    /* keep the plain file if compression fails */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
}

/**
 * A record's state as far as anyone can tell now: "running" turns into "lost" once the
 * process that wrote it is gone or has logged nothing for 15 minutes.
 */
function liveState(meta) {
  if (!meta) return 'lost';
  if (meta.state !== 'running') return meta.state;
  let heartbeat = meta.startedAt || 0;
  for (const file of [eventsFile(meta.id), eventsZstdFile(meta.id)]) {
    try {
      heartbeat = Math.max(heartbeat, fs.statSync(file).mtimeMs);
    } catch {
      /* files may be gone */
    }
  }
  const stale = Date.now() - heartbeat > 15 * 60 * 1000;
  return !pidAlive(meta.pid) || stale ? 'lost' : 'running';
}

/** Creation time (ms) encoded in a run-… or dsh-… id, 0 if there is none. */
function idTime(id) {
  const match = /^[a-z]+-([0-9a-z]+)-/.exec(String(id));
  const ms = match ? parseInt(match[1], 36) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The run records of MCP job `jobId` in task order: one for dsh_task, one per started
 * subagent for dsh_parallel. Run ids begin with their creation time, so records made
 * well before the job started are skipped without being opened.
 */
function findJob(jobId) {
  const id = String(jobId || '');
  if (!id) return [];
  const since = idTime(id) ? idTime(id) - 60_000 : 0; // slack for clock adjustments
  let names = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const runId = name.slice(0, -'.json'.length);
    const created = idTime(runId);
    if (since && created && created < since) continue;
    const meta = readMeta(runId);
    if (meta && meta.jobId === id) runs.push(meta);
  }
  return runs.sort((a, b) => (a.jobIndex || 0) - (b.jobIndex || 0) || (a.startedAt || 0) - (b.startedAt || 0));
}

function listRuns(limit = 20) {
  ensureDir();
  if (Date.now() - lastPrune > 15_000) prune();
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const meta = readMeta(name.replace(/\.json$/, ''));
    if (!meta) continue;
    meta.state = liveState(meta);
    runs.push({
      id: meta.id,
      kind: meta.kind,
      title: meta.title,
      cwd: meta.cwd,
      state: meta.state,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt || null,
      durationMs: meta.durationMs || null,
      toolCalls: meta.toolCalls || 0,
      sessionId: meta.sessionId || null,
      reason: meta.reason || null,
      text: meta.text || '',
      usage: meta.usage || null,
      tasks: meta.tasks || null,
    });
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return runs.slice(0, limit);
}

let lastPrune = 0;

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Rolling cleanup, bounded by disk size (default 256 MB, configurable — 1024 = 1 GB).
 * Deletes the oldest finished runs until the directory fits again; never removes
 * a run whose process is still writing.
 */
function prune(options = {}) {
  const settings = readSettings();
  const limitBytes =
    options.maxBytes || (settings.maxStorageMb > 0 ? settings.maxStorageMb * 1024 * 1024 : 0);
  if (!limitBytes) return; // 0 = 不限制
  try {
    const entries = fs
      .readdirSync(dir())
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => {
        const id = name.replace(/\.json$/, '');
        const file = path.join(dir(), name);
        return {
          id,
          mtime: fs.statSync(file).mtimeMs,
          bytes: sizeOf(file) + sizeOf(eventsFile(id)) + sizeOf(eventsZstdFile(id)),
          alive: pidAlive(readMeta(id) ? readMeta(id).pid : null) && (readMeta(id) || {}).state === 'running',
        };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries) {
      if (total <= limitBytes) break;
      if (entry.alive) continue;
      fs.rmSync(metaFile(entry.id), { force: true });
      fs.rmSync(eventsFile(entry.id), { force: true });
      fs.rmSync(eventsZstdFile(entry.id), { force: true });
      total -= entry.bytes;
    }
  } catch {
    /* cleanup must never break a run */
  }
  lastPrune = Date.now();
}


function storageInfo() {
  ensureDir();
  let runs = 0;
  let compressed = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir())) {
      const file = path.join(dir(), name);
      bytes += sizeOf(file);
      if (name.endsWith('.json') && !name.startsWith('.')) runs += 1;
      if (name.endsWith('.jsonl.zstd')) compressed += 1;
    }
  } catch {
    /* ignore */
  }
  return { dir: dir(), runs, compressed, bytes };
}

module.exports = {
  createRun,
  update,
  append,
  finish,
  interrupt,
  listRuns,
  liveState,
  findJob,
  readEvents,
  readMeta,
  dir,
  prune,
  storageInfo,
  compressEvents,
};
