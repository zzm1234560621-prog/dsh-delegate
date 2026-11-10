'use strict';

/**
 * Token accounting for a finished run.
 *
 * DSH writes each session as a chain of zstd frames (one per flush) containing
 * JSONL events; assistant messages carry the provider usage block. Summing that
 * gives exact input/output/cache numbers for the worker we just ran.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { dshHome } = require('./dsh');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Concatenated zstd frames: decompress each one, because the sync API stops at the first. */
function decompressAll(buffer) {
  const starts = [];
  let index = buffer.indexOf(MAGIC, 0);
  while (index !== -1) {
    starts.push(index);
    index = buffer.indexOf(MAGIC, index + 4);
  }
  if (starts.length === 0) return zlib.zstdDecompressSync(buffer).toString('utf8');

  let text = '';
  for (let i = 0; i < starts.length; i += 1) {
    const slice = buffer.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buffer.length);
    try {
      text += zlib.zstdDecompressSync(slice).toString('utf8');
    } catch {
      /* trailing partial frame while the run is still flushing */
    }
  }
  return text;
}

function findSessionLog(sessionId) {
  if (!sessionId) return null;
  const root = path.join(dshHome(), 'sessions');
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    const log = path.join(root, workspace.name, sessionId, 'session.v4.jsonl.zstd');
    if (fs.existsSync(log)) return log;
  }
  return null;
}

/**
 * @param {string} sessionId
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, total:number,
 *            calls:number, firstAt:number|null, lastAt:number|null}|null}
 */
function summarize(sessionId) {
  const log = findSessionLog(sessionId);
  if (!log) return null;

  let text;
  try {
    text = decompressAll(fs.readFileSync(log));
  } catch {
    return null;
  }

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, calls: 0, firstAt: null, lastAt: null };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const usage =
      (event.data && event.data.message && event.data.message.source &&
        event.data.message.source.replayState &&
        event.data.message.source.replayState.response &&
        event.data.message.source.replayState.response.usage) ||
      (event.data && event.data.usage) ||
      null;
    if (!usage) continue;
    totals.input += Number(usage.input || 0);
    totals.output += Number(usage.output || 0);
    totals.cacheRead += Number(usage.cacheRead || 0);
    totals.cacheWrite += Number(usage.cacheWrite || 0);
    totals.total += Number(usage.totalTokens || (usage.input || 0) + (usage.output || 0));
    totals.calls += 1;
    const at = Number(event.time || (event.data && event.data.time) || 0);
    if (at) {
      if (!totals.firstAt || at < totals.firstAt) totals.firstAt = at;
      if (!totals.lastAt || at > totals.lastAt) totals.lastAt = at;
    }
  }

  if (totals.calls === 0) return null;
  return totals;
}

/** Attach throughput numbers once a run's wall time is known. */
function withSpeed(usage, wallMs) {
  if (!usage) return null;
  const seconds = Math.max(wallMs || 0, 1) / 1000;
  return {
    ...usage,
    wallMs: Math.round(wallMs || 0),
    outputPerSecond: Math.round((usage.output / seconds) * 10) / 10,
    totalPerSecond: Math.round((usage.total / seconds) * 10) / 10,
  };
}

module.exports = { summarize, withSpeed, findSessionLog, decompressAll };
