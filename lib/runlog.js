'use strict';

/**
 * Append-only run log so the local UI can watch subagents the MCP server
 * started in another process.
 *
 * Layout (under $DSH_HOME/delegate-runs):
 *   <id>.json    metadata + final state
 *   <id>.jsonl   event stream (one JSON object per line)
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
  writeMeta(id, record);
  fs.writeFileSync(eventsFile(id), '');
  return record;
}

function append(record, event) {
  if (!record) return;
  try {
    fs.appendFileSync(eventsFile(record.id), `${JSON.stringify({ t: Date.now(), ...event })}\n`);
    record.writes = (record.writes || 0) + 1;
    if (record.writes % 100 === 0) trimEvents(record);
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

function finish(record, summary) {
  if (!record) return;
  const meta = {
    ...readMeta(record.id),
    state: summary.ok ? 'done' : 'failed',
    endedAt: Date.now(),
    durationMs: summary.durationMs,
    sessionId: summary.sessionId || null,
    reason: summary.reason || null,
    text: summary.text ? String(summary.text).slice(0, 4000) : '',
    toolCalls: record.toolCalls || 0,
  };
  try {
    writeMeta(record.id, meta);
  } catch {
    /* ignore */
  }
  compressEvents(record.id);
  prune();
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
    if (meta.state === 'running' && !pidAlive(meta.pid)) meta.state = 'lost';
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
      tasks: meta.tasks || null,
    });
  }
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return runs.slice(0, limit);
}

const MAX_STORAGE_MB = 256;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
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
  const limitBytes = options.maxBytes || (settings.maxStorageMb || MAX_STORAGE_MB) * 1024 * 1024;
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

/** Keep one run's event file bounded while it is still being written. */
function trimEvents(record) {
  const file = eventsFile(record.id);
  if (sizeOf(file) < MAX_EVENT_BYTES) return;
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(-800).join('\n')}\n`);
  } catch {
    /* ignore */
  }
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

module.exports = { createRun, append, finish, listRuns, readEvents, readMeta, dir, prune, storageInfo, compressEvents };
