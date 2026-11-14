'use strict';

/**
 * Plan-quota snapshots and delegation advice for Claude Code and Codex.
 *
 * Claude Code hands its statusline a `rate_limits` object; Codex writes
 * `rate_limits` into its rollout logs. Both are copied into one small snapshot
 * shape so the dashboard and the MCP tools can reason about them without
 * depending on either client. Every file read is best-effort: a missing or
 * broken file simply means "no snapshot".
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dshHome } = require('./dsh');
const { readSettings } = require('./config');

const WINDOW_KEYS = ['five_hour', 'seven_day'];
const LIMIT_LABELS = {
  five_hour: '5 小时',
  seven_day: '本周',
  seven_day_opus: '本周 Opus',
  seven_day_sonnet: '本周 Sonnet',
};

/** Human label for a rate-limit window type, e.g. 'five_hour' → '5 小时'. */
function limitLabel(type) {
  return LIMIT_LABELS[type] || '套餐';
}

/** The window slot a rate-limit type belongs to. */
function limitWindow(type) {
  return typeof type === 'string' && type.startsWith('seven_day') ? 'seven_day' : 'five_hour';
}

/** Where Claude Code keeps per-project session transcripts. */
function claudeProjectsDir() {
  return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
}

function quotaFile() {
  return path.join(dshHome(), 'quota', 'claude.json');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** One Claude statusline window, or null when the percentage is unusable. */
function claudeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!finite(raw.used_percentage)) return null;
  const window = { used: raw.used_percentage };
  if (finite(raw.resets_at)) window.resetsAt = raw.resets_at;
  return window;
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing else to clean up */
    }
    throw error;
  }
}

/** Store a Claude Code statusline payload. Returns null when it has no quota data. */
function recordClaude(statusInput, now = Date.now()) {
  const limits = statusInput && typeof statusInput === 'object' ? statusInput.rate_limits : null;
  if (!limits || typeof limits !== 'object') return null;

  const windows = {};
  const fiveHour = claudeWindow(limits.five_hour);
  const sevenDay = claudeWindow(limits.seven_day);
  if (fiveHour) windows.five_hour = fiveHour;
  if (sevenDay) windows.seven_day = sevenDay;
  if (Object.keys(windows).length === 0) return null;

  const snapshot = { source: 'claude', at: now, windows };
  try {
    writeAtomic(quotaFile(), `${JSON.stringify(snapshot)}\n`);
  } catch {
    /* Persistence is best-effort; the live snapshot is still useful. */
  }
  return snapshot;
}

/** Read the last Claude snapshot from disk, dropping windows that have already reset. */
function readClaudeFile(now = Date.now()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(quotaFile(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.windows || typeof parsed.windows !== 'object') {
    return null;
  }

  const windows = {};
  for (const key of WINDOW_KEYS) {
    const raw = parsed.windows[key];
    if (!raw || typeof raw !== 'object' || !finite(raw.used)) continue;
    if (finite(raw.resetsAt) && raw.resetsAt * 1000 <= now) continue;
    const window = { used: raw.used };
    if (finite(raw.resetsAt)) window.resetsAt = raw.resetsAt;
    windows[key] = window;
  }
  if (Object.keys(windows).length === 0) return null;

  return {
    source: 'claude',
    at: finite(parsed.at) ? parsed.at : now,
    windows,
  };
}

/**
 * Claude's quota as far as this machine can tell: the last statusline snapshot,
 * plus the newest "this window is used up" record from a Claude Code session log.
 * The desktop app's Code tab never runs the statusline, so for it the 429 written
 * into the transcript is the only trace that a plan window is exhausted.
 */
function readClaude(now = Date.now()) {
  const stored = readClaudeFile(now);
  const limit = readClaudeLimit(now);
  if (!stored) {
    return limit ? { source: 'claude', at: limit.at, windows: {}, limit } : null;
  }
  if (limit && (!stored.limit || limit.at >= stored.limit.at)) {
    // A statusline sample taken *after* the exhausted record wins: the window has
    // either reset or the record belongs to a previous one. Keeping both produced
    // "5h 82%" next to "已触顶", and the advice then wrongly said the window was
    // used up. Only keep the limit when it is newer than the last sample.
    if (!finite(stored.at) || limit.at >= stored.at) stored.limit = limit;
  }
  return stored;
}

/** Directory entries, newest name first. Missing/unreadable directories are empty. */
function dirsNewestFirst(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** rollout-*.jsonl files for one day, newest mtime first. */
function rolloutsNewestFirst(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* an unreadable file is just skipped */
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

/** Last at most 512KB of a file, as text. */
function readTail(file, maxBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    if (length > 0) fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

/** Claude Code transcripts under the projects root, newest first. */
function transcriptFilesNewestFirst(root, maxFiles = 12) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* an unreadable transcript is just skipped */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, maxFiles);
}

/**
 * One usage-limit record from a transcript → {at, type, window, resetsAt}, or null.
 * Claude Code writes `{apiError:"usage_limit_reached", apiErrorParams:{rate_limit_info}}`
 * (and, in newer builds, a parallel `quotaLimits`) when an API call is rejected.
 */
function limitRecord(event, now) {
  if (!event || typeof event !== 'object') return null;
  const info =
    (event.apiErrorParams && event.apiErrorParams.rate_limit_info) || event.quotaLimits || null;
  if (!info || typeof info !== 'object') return null;
  if (typeof info.status === 'string' && info.status !== 'rejected') return null;
  if (!finite(info.resetsAt) || info.resetsAt * 1000 <= now) return null;

  const type =
    typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : 'five_hour';
  const parsed = Date.parse(typeof event.timestamp === 'string' ? event.timestamp : '');
  return {
    at: Number.isFinite(parsed) ? parsed : now,
    resetsAt: info.resetsAt,
    type,
    window: limitWindow(type),
  };
}

let limitCache = { key: '', checkedAt: 0, value: null };

/**
 * The newest unexpired "window used up" record in the Claude Code session logs.
 * null when no transcript has one, or when every one has already reset.
 */
function readClaudeLimit(now = Date.now(), root = claudeProjectsDir()) {
  const files = transcriptFilesNewestFirst(root);
  const newestFile = files[0];
  const key = newestFile
    ? `${root}|${newestFile.file}|${newestFile.mtimeMs}|${newestFile.size}`
    : `${root}|empty`;
  if (limitCache.key === key && now - limitCache.checkedAt < 10000) return limitCache.value;

  let newest = null;
  for (const entry of files) {
    let text;
    try {
      text = readTail(entry.file, 256 * 1024);
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('usage_limit_reached') && !line.includes('"quotaLimits"')) continue;
      let event;
      try {
        // PowerShell-written test fixtures may carry a UTF-8 BOM.
        event = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
      } catch {
        continue;
      }
      const record = limitRecord(event, now);
      if (record && (!newest || record.at > newest.at)) newest = record;
    }
  }

  limitCache = { key, checkedAt: now, value: newest };
  return newest;
}

/** primary/secondary rate limits -> our two window slots, expired ones dropped. */
function codexWindows(limits, now) {
  const windows = {};
  for (const key of ['primary', 'secondary']) {
    const raw = limits[key];
    if (!raw || typeof raw !== 'object') continue;
    if (!finite(raw.used_percent)) continue;
    if (!finite(raw.window_minutes)) continue;
    if (finite(raw.resets_at) && raw.resets_at * 1000 <= now) continue;

    const slot = raw.window_minutes <= 1440 ? 'five_hour' : 'seven_day';
    const window = { used: raw.used_percent };
    if (finite(raw.resets_at)) window.resetsAt = raw.resets_at;
    windows[slot] = window;
  }
  return windows;
}

/**
 * Inspect one rollout log.
 * undefined = no usable rate_limits line (keep looking)
 * null      = a rate_limits line was found but every window is expired
 * object    = snapshot for this file
 */
function rolloutSnapshot(file, mtimeMs, now) {
  let text;
  try {
    text = readTail(file);
  } catch {
    return undefined;
  }

  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"rate_limits"')) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;

    let limits = event.payload && event.payload.rate_limits;
    if (!limits && event.rate_limits) limits = event.rate_limits;
    if (!limits || typeof limits !== 'object') continue;
    if (!limits.primary && !limits.secondary) continue;

    const windows = codexWindows(limits, now);
    if (Object.keys(windows).length === 0) return null;
    return { source: 'codex', at: mtimeMs, windows };
  }
  return undefined;
}

/**
 * Find the newest Codex snapshot under <codexHome>/sessions/YYYY/MM/DD/.
 * Walks dates newest-first, then files by mtime, checking at most 20 files.
 */
function readCodex(
  now = Date.now(),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
) {
  const sessions = path.join(codexHome, 'sessions');
  let checked = 0;

  for (const year of dirsNewestFirst(sessions)) {
    const yearDir = path.join(sessions, year);
    for (const month of dirsNewestFirst(yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of dirsNewestFirst(monthDir)) {
        const dayDir = path.join(monthDir, day);
        for (const entry of rolloutsNewestFirst(dayDir)) {
          if (checked >= 20) return null;
          checked += 1;
          const snapshot = rolloutSnapshot(entry.file, entry.mtimeMs, now);
          if (snapshot !== undefined) return snapshot;
        }
      }
    }
  }
  return null;
}

/** Delegation thresholds, falling back as a pair when the settings make no sense. */
function thresholds() {
  let settings = {};
  try {
    settings = readSettings() || {};
  } catch {
    settings = {};
  }
  const high = settings.quotaHighPct;
  const critical = settings.quotaCriticalPct;
  if (!finite(high) || !finite(critical) || !(high > 0 && high < critical && critical <= 100)) {
    return { high: 70, critical: 90 };
  }
  return { high, critical };
}

/** 'unknown' | 'normal' | 'high' | 'critical' from the busiest window (or a used-up one). */
function level(snapshot, t = thresholds()) {
  if (!snapshot || typeof snapshot !== 'object') return 'unknown';
  if (
    snapshot.limit &&
    finite(snapshot.limit.resetsAt) &&
    snapshot.limit.resetsAt * 1000 > Date.now()
  ) {
    return 'critical';
  }
  const windows = snapshot.windows && typeof snapshot.windows === 'object' ? snapshot.windows : {};

  let max = null;
  for (const key of Object.keys(windows)) {
    const raw = windows[key];
    if (!raw || !finite(raw.used)) continue;
    if (max === null || raw.used > max) max = raw.used;
  }
  if (max === null) return 'unknown';

  const high = t && finite(t.high) ? t.high : 70;
  const critical = t && finite(t.critical) ? t.critical : 90;
  if (max >= critical) return 'critical';
  if (max >= high) return 'high';
  return 'normal';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Local reset label: HH:mm today, otherwise M月D日 HH:mm. */
function formatReset(resetsAtSeconds, now = Date.now()) {
  if (!finite(resetsAtSeconds) || !finite(now)) return '';
  const reset = new Date(resetsAtSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return '';
  const current = new Date(now);
  const time = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
  if (
    reset.getFullYear() === current.getFullYear() &&
    reset.getMonth() === current.getMonth() &&
    reset.getDate() === current.getDate()
  ) {
    return time;
  }
  return `${reset.getMonth() + 1}月${reset.getDate()}日 ${time}`;
}

/** Chinese prompt for the model, or '' when there is no reason to push work out. */
function advice(snapshot, who, t = thresholds()) {
  const state = level(snapshot, t);
  if (state !== 'high' && state !== 'critical') return '';

  const now = Date.now();
  const limit = snapshot && snapshot.limit;
  if (limit && finite(limit.resetsAt) && limit.resetsAt * 1000 > now) {
    const reset = formatReset(limit.resetsAt, now);
    return (
      `${who} 的${limitLabel(limit.type)}额度已经用尽${reset ? `（${reset} 重置）` : ''}：` +
      '除了必须自己拿主意的部分，能派的全部派给 DSH（dsh_task / dsh_parallel，互不依赖的活一次并行派出），' +
      '尽量少在本会话里直接读写大文件。'
    );
  }

  const windows = snapshot && snapshot.windows && typeof snapshot.windows === 'object' ? snapshot.windows : {};
  const labels = { five_hour: '5 小时', seven_day: '本周' };
  const parts = [];
  let max = null;

  for (const key of WINDOW_KEYS) {
    const raw = windows[key];
    if (!raw || !finite(raw.used)) continue;
    if (max === null || raw.used > max) max = raw.used;

    const percent = Math.round(raw.used);
    const label = labels[key];
    if (finite(raw.resetsAt)) {
      const reset = formatReset(raw.resetsAt, now);
      parts.push(reset ? `${label} ${percent}%（${reset} 重置）` : `${label} ${percent}%`);
    } else {
      parts.push(`${label} ${percent}%`);
    }
  }
  if (max === null || parts.length === 0) return '';

  const m = Math.round(max);
  const list = parts.join('，');
  if (state === 'critical') {
    const left = Math.max(1, 100 - m);
    return (
      `${who} 的套餐额度只剩不到 ${left}%：${list}。` +
      '除了必须自己拿主意的部分，能派的全部派给 DSH（dsh_task / dsh_parallel，互不依赖的活一次并行派出），' +
      '尽量少在本会话里直接读写大文件。'
    );
  }
  return (
    `${who} 的套餐额度已用到 ${m}%：${list}。` +
    '接下来凡是能用一段自包含说明写清楚的活（批量改文件、写小脚本、查报错、跑检查并汇总等），' +
    '优先用 dsh_task / dsh_parallel 派给 DSH，自己只做判断、拆分和审阅。'
  );
}

/** Everything a dashboard or CLI needs in one call. */
function summary(now = Date.now()) {
  const t = thresholds();
  const claude = readClaude(now);
  const codex = readCodex(now);
  return {
    claude: { snapshot: claude, level: level(claude, t) },
    codex: { snapshot: codex, level: level(codex, t) },
    thresholds: t,
  };
}

module.exports = {
  quotaFile,
  recordClaude,
  readClaude,
  readClaudeLimit,
  readCodex,
  thresholds,
  level,
  advice,
  summary,
  formatReset,
  limitLabel,
};
