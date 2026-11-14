'use strict';

/**
 * MCP stdio server.
 *
 * Design notes:
 * - Host clients give a tool call a limited patience (Claude Desktop aborts
 *   around a minute). A real DSH task can take several minutes, so every call
 *   starts a *job*: if it finishes inside `soft_wait_ms` the answer comes back
 *   inline, otherwise the call returns a job id and the client polls `dsh_job`.
 * - While a job runs, progress notifications are emitted (`notifications/progress`)
 *   whenever the client supplied a progress token, mirroring how a subagent
 *   shows live activity.
 */

const { runTask, mapLimit, killAll, killTree } = require('./dsh');
const { readSettings } = require('./config');
const runlog = require('./runlog');

const SERVER_INFO = { name: 'dsh-delegate', version: '1.1.0' };
const PROTOCOL_FALLBACK = '2024-11-05';
const DEFAULT_CONCURRENCY = 0; // 0 = 不限制
const DEFAULT_SOFT_WAIT_MS = 45_000;

const ROUTING_NOTE = [
  '适合交给它：边界清楚、不需要当前对话上下文就能说清的单步任务 —— 解释代码或报错、',
  '查命令写法、生成小脚本或正则、对文件做批量机械改写、跑一次检查并总结、整理数据。',
  '',
  '不适合：必须与本轮对话紧密交错的多轮协作、需要你逐行审阅大 diff 的重构、依赖刚建立的隐含上下文的工作。',
].join('\n');

const ASYNC_NOTE = [
  '长任务怎么拿结果：DSH 可能要跑几分钟。本工具最多等 soft_wait_ms（默认 45s）：',
  '在这之内完成就直接返回答复；没完成会返回一行 job=… 的「运行中」状态 —— 那**不是失败**。',
  '接着用 dsh_job({job_id}) 继续等（每次最多再等 45s），直到 state=done/failed。',
  '也可以在第一次调用时传 mode="async" 立刻拿 job id，然后专心轮询。',
].join('\n');

const SCOPE_DOC = [
  '写边界：子代理的工作目录就是唯一可写根（读不受限，可以看整个仓库）。',
  '传 write_scope（相对 cwd 的已存在子目录）可以把可写范围收缩到那里，越界写会被沙箱拒绝。',
].join('\n');

const TOOLS = [
  {
    name: 'dsh_task',
    title: 'Delegate one task to DeepSeek Harness (DSH)',
    description: [
      '把一件自成一体的小任务交给本机的 DeepSeek Harness 子代理，在它自己的一次独立运行中完成，返回最终答复。',
      '',
      ROUTING_NOTE,
      '',
      ...SCOPE_DOC,
      '',
      ASYNC_NOTE,
      '',
      '每次调用默认是全新会话，在 cwd 指向的目录里执行（默认当前工作目录）。',
      '沙箱模式和审批策略由本机设置决定（默认 workspace-write + never，可在 `dsh-delegate ui` 里改）；',
      '需要越过工作目录时显式传 permission_mode:"danger-full-access"。',
      '答案第一行是状态行（耗时 / 退出码 / 沙箱 / 写边界 / 会话 id），其后是最终答复。',
      '要接着上次继续，把上一次状态行里的 session_id 传回 session_id。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给 DSH 的任务说明：目标、涉及的文件或目录、完成标准。它看不到本轮对话。',
        },
        cwd: { type: 'string', description: '工作目录；省略用当前工作目录。' },
        write_scope: {
          type: 'string',
          description: '把可写范围收缩到 cwd 下的某个已存在子目录（相对路径）；读不受限。',
        },
        session_id: { type: 'string', description: '续接的会话 id（session-…）。' },
        permission_mode: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description: 'workspace-write（默认）或 danger-full-access。',
        },
        approval_policy: {
          type: 'string',
          enum: ['never', 'ask'],
          description: '省略时用本机设置。ask 需要有人应答，headless 下没人应答会一直等到超时。',
        },
        timeout_ms: { type: 'number', description: 'DSH 自身超时毫秒；默认 0 = 不限制。' },
        no_web: { type: 'boolean', description: '为这次调用禁用联网工具（默认 false，可联网）。' },
        soft_wait_ms: {
          type: 'number',
          description: `本次调用最多等多久再交还 job id，默认 ${DEFAULT_SOFT_WAIT_MS}；0 = 一直等到结束。`,
        },
        mode: {
          type: 'string',
          enum: ['auto', 'async'],
          description: 'auto（默认，等到 soft_wait 再决定）或 async（立刻返回 job id）。',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_parallel',
    title: 'Fan out several tasks to DSH subagents in parallel',
    description: [
      '一次派出多个 DSH 子代理并行干活，全部结束后按编号汇总每份结果。用来把大活拆成互不依赖的几块同时推进。',
      '',
      '什么时候用：2 件以上互不依赖的活（各自改不同目录、各自查不同问题、各自跑不同检查）。默认不限制并发，全部同时跑。',
      '',
      '关键约束：子代理共享同一个仓库，**能读整个仓库**（相互查看），但每个任务只应写自己的目录。',
      '给每个任务填 write_scope，沙箱会把写边界收缩到那里，越界写会被拒绝。',
      '要并行改同一批文件会互相覆盖 —— 这种情况要么串行，要么让每个任务在各自的 git worktree 里做。',
      '',
      ASYNC_NOTE,
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          description: '要并行派出的任务列表。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '短标题，用于汇总里区分。' },
              task: { type: 'string', description: '自包含的任务说明。' },
              cwd: { type: 'string', description: '该任务的工作目录；省略用父级默认。' },
              write_scope: {
                type: 'string',
                description: '该任务唯一可写的子目录（相对 cwd，必须已存在）。建议每个任务都填，互不重叠。',
              },
              session_id: { type: 'string', description: '续接已有会话（一般不用）。' },
              no_web: { type: 'boolean', description: '禁用联网工具，只读本地。' },
            },
            required: ['task'],
            additionalProperties: false,
          },
        },
        cwd: { type: 'string', description: '所有任务的默认工作目录。' },
        max_concurrency: {
          type: 'number',
          description: '并发上限。省略或 0 = 不限制，全部同时跑。',
        },
        permission_mode: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description: '对所有任务生效；省略时用本机设置。',
        },
        approval_policy: { type: 'string', enum: ['never', 'ask'], description: '省略时用本机设置。' },
        timeout_ms: { type: 'number', description: '每个任务的超时毫秒；默认 0 = 不限制。' },
        soft_wait_ms: {
          type: 'number',
          description: `本次调用最多等多久再交还 job id，默认 ${DEFAULT_SOFT_WAIT_MS}。`,
        },
        mode: { type: 'string', enum: ['auto', 'async'], description: 'auto 或 async。' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_job',
    title: 'Check or wait for a running DSH job',
    description: [
      '查询 dsh_task / dsh_parallel 交还的 job_id。默认最多再等 wait_ms（45s）：',
      '完成就返回完整结果，没完成就返回运行状态和最近的活动。反复调用直到 state=done 或 failed。',
      'action="cancel" 会终止该作业（连同它的子代理进程）。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'dsh_task / dsh_parallel 返回的 job id。' },
        wait_ms: {
          type: 'number',
          description: `最多等多久，默认 ${DEFAULT_SOFT_WAIT_MS}，不设上限。`,
        },
        action: { type: 'string', enum: ['wait', 'cancel'], description: 'wait（默认）或 cancel。' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- jobs

/** @type {Map<string, any>} */
const jobs = new Map();
let jobSeq = 0;

function formatDuration(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function clip(text) {
  return text;
}

function startJob(meta, runner) {
  const id = `dsh-${Date.now().toString(36)}-${(jobSeq += 1)}`;
  const job = {
    id,
    kind: meta.kind,
    title: meta.title,
    startedAt: Date.now(),
    state: 'running',
    progress: [],
    result: null,
    error: null,
    cancelled: false,
    children: new Set(), // this job's worker processes, so cancel stops only them
    lastProgressAt: 0,
    run: null,
  };
  jobs.set(id, job);

  const control = {
    track(child) {
      job.children.add(child);
      child.once('close', () => job.children.delete(child));
      if (job.cancelled) killTree(child);
    },
    get cancelled() {
      return job.cancelled;
    },
  };

  // Mirror the run to disk so the local UI can watch several subagents at once.
  // A parallel batch gets one run record per task instead of one aggregate record.
  let run = null;
  if (meta.kind !== 'parallel') {
    try {
      run = runlog.createRun({ kind: meta.kind, title: meta.title, cwd: meta.cwd, tasks: meta.tasks });
    } catch {
      run = null;
    }
  }
  job.run = run;

  const onEvent = (event) => {
    const note = describeEvent(event);
    if (run) recordEvent(run, event);
    if (!note) return;
    job.progress.push(note);
    if (job.progress.length > 20) job.progress.shift();
    job.lastNote = note;
    job.lastAt = Date.now();
    emitProgress(job);
  };

  job.promise = runner(onEvent, control)
    .then((result) => {
      if (job.cancelled) return result; // cancel already recorded the outcome
      job.state = 'done';
      job.result = result;
      job.endedAt = Date.now();
      if (run) {
        const summary = result && result.results ? result : { ...result };
        runlog.finish(run, {
          ok: result && result.results ? result.results.every((item) => item.ok) : Boolean(result.ok),
          durationMs: result && result.wallMs ? result.wallMs : result && result.durationMs,
          sessionId: result && result.sessionId,
          text: result && result.results ? `${result.results.length} 个子代理完成` : result && result.text,
          reason: '',
          usage: result && result.usage,
        });
      }
      emitProgress(job);
      return result;
    })
    .catch((cause) => {
      if (job.cancelled) return;
      job.state = 'failed';
      job.error = cause && cause.message ? cause.message : String(cause);
      job.endedAt = Date.now();
      if (run) runlog.finish(run, { ok: false, durationMs: Date.now() - job.startedAt, reason: job.error });
      emitProgress(job);
    });
  return job;
}

function recordEvent(run, event) {
  if (!run) return;
  if (event.type === 'tool_call') {
    runlog.append(run, { kind: 'tool', name: event.name || event.tool, detail: toolDetail(event) });
  } else if (event.type === 'status' && event.phase === 'turn_start') {
    runlog.append(run, { kind: 'turn', turn: event.turn });
  } else if (event.type === 'text' && typeof event.text === 'string' && event.text.trim()) {
    runlog.append(run, { kind: 'text', text: event.text.slice(0, 4000) });
  } else if (event.type === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
    runlog.append(run, { kind: 'thinking', text: event.text.slice(0, 4000) });
  } else if (event.type === 'tool_result') {
    runlog.append(run, {
      kind: 'result',
      status: event.status || 'completed',
      text: String(event.result === undefined ? '' : event.result).slice(0, 4000),
    });
  }
}

function toolDetail(event) {
  const args = event.input || event.arguments || event.args || {};
  const detail = args.command || args.cmd || args.path || args.file_path || args.query || args.pattern || '';
  return detail ? String(detail).slice(0, 200) : '';
}

function describeEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (event.type === 'status' && event.phase === 'turn_start') return `开始第 ${event.turn} 轮`;
  if (event.type === 'status' && event.phase === 'step_start') return `第 ${event.turn} 轮 · 第 ${event.step} 步`;
  if (event.type === 'tool_call') {
    const name = event.name || event.tool || 'tool';
    const args = event.input || event.arguments || event.args || {};
    const detail = args.command || args.cmd || args.path || args.file_path || args.query || '';
    return `调用 ${name}${detail ? `：${String(detail).slice(0, 80)}` : ''}`;
  }
  if (event.type === 'tool_result') return `工具返回${event.name ? `（${event.name}）` : ''}`;
  return null;
}

/**
 * Progress notifications keep some hosts from treating the call as hung.
 * A token is only valid while the request that carried it is still open, so it is
 * registered for the duration of one tools/call and dropped before the reply.
 */
const progressTokens = new Map(); // job id -> token of the call currently waiting on it

function emitProgress(job) {
  const token = progressTokens.get(job.id);
  if (token === undefined) return;
  const now = Date.now();
  const finished = job.state !== 'running';
  if (!finished && now - job.lastProgressAt < 1200) return;
  job.lastProgressAt = now;
  sendNotification('notifications/progress', {
    progressToken: token,
    progress: job.progress.length,
    message: finished
      ? `DSH ${job.state === 'done' ? '完成' : '失败'}（${formatDuration((job.endedAt || now) - job.startedAt)}）`
      : `DSH 运行中 ${formatDuration(now - job.startedAt)}${job.lastNote ? ` · ${job.lastNote}` : ''}`,
  });
}

/** Finished jobs stay pollable for a while, then go. */
function retire(job) {
  progressTokens.delete(job.id);
  if (job.state !== 'running') setTimeout(() => jobs.delete(job.id), 5 * 60_000).unref?.();
}

function waitFor(job, ms) {
  const raw = Number.isFinite(ms) ? ms : readSettings().softWaitMs;
  // 0 = 不设上限：一直等到作业结束
  if (raw === 0) return job.promise.then(() => 'settled');
  const budget = raw > 0 ? raw : DEFAULT_SOFT_WAIT_MS;
  return Promise.race([
    job.promise.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), budget).unref?.()),
  ]);
}

// ---------------------------------------------------------------- rendering

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function statusLine(result) {
  const scope = result.scope ? ` · write:${result.scope}` : '';
  const usage = result.usage
    ? ` · ${formatTokens(result.usage.total)} tok（出 ${formatTokens(result.usage.output)}）· ${result.usage.outputPerSecond} tok/s`
    : '';
  return (
    `[DSH ${result.ok ? 'ok' : 'failed'} · ${formatDuration(result.durationMs)} · exit ${result.code} · ` +
    `${result.permissionMode}${scope}${usage} · ${result.sessionId || 'no-session-id'}]`
  );
}

function renderSingle(result) {
  const parts = [statusLine(result)];
  const body = result.text.trim().length ? result.text : result.ok ? '（没有产出文本答复）' : '';
  if (body) parts.push(body);
  if (!result.ok) {
    if (result.reason) parts.push(`原因：${result.reason}`);
    if (result.stderrTail) parts.push(`stderr（末尾）：\n${result.stderrTail}`);
  }
  return { text: parts.join('\n'), isError: !result.ok };
}

function renderParallel(payload) {
  const { results, tasks, wallMs, limit } = payload;
  const okCount = results.filter((r) => r.ok).length;
  const serial = results.reduce((sum, r) => sum + r.durationMs, 0);
  const header =
    `[DSH 并行 · ${okCount}/${results.length} 成功 · 墙钟 ${formatDuration(wallMs)} · ` +
    `并发 ${limit} · 串行需约 ${formatDuration(serial)}]`;

  const sections = results.map((result, index) => {
    const title = (tasks[index] && tasks[index].title) || `任务 ${index + 1}`;
    const body = result.text.trim().length
      ? result.text
      : result.ok
        ? '（没有产出文本答复）'
        : result.reason || '失败';
    return [`## ${index + 1}/${results.length} · ${title} — ${statusLine(result)}`, clip(body)].join('\n');
  });

  let text = [header, ...sections].join('\n\n');
  if (okCount !== results.length) {
    const failed = results
      .map((r, i) => (!r.ok ? `${i + 1}(${(tasks[i] && tasks[i].title) || `任务 ${i + 1}`})` : null))
      .filter(Boolean)
      .join('、');
    text += `\n\n失败：${failed} —— 带着各自的「原因 / stderr」重派，比原样重试有用。`;
  }
  return { text, isError: okCount === 0 };
}

function renderRunning(job) {
  const elapsed = formatDuration(Date.now() - job.startedAt);
  const recent = job.progress.slice(-3).map((note) => `· ${note}`).join('\n');
  return {
    text: [
      `[DSH 运行中 · ${elapsed} · job=${job.id} · ${job.kind}]`,
      '还没结束，这不是失败。用 dsh_job 继续等：{"job_id":"' + job.id + '"}（每次最多 45s），直到 state=done/failed。',
      recent ? `最近活动：\n${recent}` : '（暂无活动输出）',
    ].join('\n'),
    isError: false,
  };
}

function renderJob(job) {
  if (job.state === 'running') return renderRunning(job);
  if (job.state === 'cancelled') {
    return { text: `[DSH 作业已取消 · job=${job.id} · ${formatDuration(job.endedAt - job.startedAt)}]`, isError: false };
  }
  if (job.state === 'failed') return { text: `[DSH 作业失败 · job=${job.id}]\n${job.error}`, isError: true };
  if (job.kind === 'parallel') return renderParallel(job.result);
  return renderSingle(job.result);
}

// ---------------------------------------------------------------- tool impls

function textResult(text, isError) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function softWait(args) {
  const raw = args.soft_wait_ms;
  if (raw === 0) return 0; // documented: 0 = wait until the job ends
  if (Number.isFinite(raw) && raw > 0) return raw;
  return readSettings().softWaitMs || DEFAULT_SOFT_WAIT_MS;
}

/** Wait up to `budget` while the caller's progress token is live, then render the job. */
async function awaitJob(job, budget, ctx) {
  if (ctx && ctx.progressToken !== undefined) progressTokens.set(job.id, ctx.progressToken);
  try {
    if (job.state === 'running') await waitFor(job, budget);
  } finally {
    progressTokens.delete(job.id);
  }
  const rendered = renderJob(job);
  if (job.state !== 'running') retire(job);
  return textResult(rendered.text, rendered.isError);
}

async function callTask(args, ctx) {
  const input = args || {};
  if (String(input.task || '').trim().length === 0) return textResult('task 不能为空。', true);

  const defaults = readSettings();
  const job = startJob(
    { kind: 'task', title: String(input.task || '').slice(0, 60), cwd: input.cwd },
    (onEvent, control) =>
      runTask({
        task: input.task,
        cwd: input.cwd,
        writeScope: input.write_scope,
        sessionId: input.session_id,
        permissionMode: input.permission_mode || defaults.permissionMode,
        approvalPolicy: input.approval_policy || defaults.approvalPolicy,
        timeoutMs: input.timeout_ms || defaults.timeoutMs,
        noWeb: Boolean(input.no_web),
        onEvent,
        onSpawn: control.track,
      }),
  );

  if (input.mode === 'async') return textResult(renderRunning(job).text, false);
  return awaitJob(job, softWait(input), ctx);
}

function cancelledResult(input, defaults) {
  return {
    ok: false,
    durationMs: 0,
    code: 'cancelled',
    sessionId: '',
    text: '',
    reason: '作业已取消，未启动',
    stderrTail: '',
    permissionMode: input.permission_mode || defaults.permissionMode,
    scope: '',
    cwd: '',
  };
}

async function callParallel(args, ctx) {
  const input = args || {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (tasks.length === 0) return textResult('tasks 不能为空。', true);

  const defaults = readSettings();
  const requested = Number.isFinite(input.max_concurrency)
    ? Math.floor(input.max_concurrency)
    : Number(defaults.maxConcurrency || 0);
  const limit = requested > 0 ? Math.min(requested, tasks.length) : tasks.length;
  const startedAt = Date.now();

  const job = startJob(
    {
      kind: 'parallel',
      title: `${tasks.length} 个任务`,
      cwd: input.cwd,
      tasks: tasks.map((item) => (item && item.title) || '任务'),
    },
    async (onEvent, control) => {
      const results = await mapLimit(tasks, limit, async (item) => {
        const task = item || {};
        if (control.cancelled) return cancelledResult(input, defaults); // queued behind a cap
        // One run record per subagent, so the local UI can show them side by side.
        let taskRun = null;
        try {
          taskRun = runlog.createRun({
            kind: 'subagent',
            title: task.title || (task.task ? String(task.task).slice(0, 60) : '子代理'),
            cwd: task.cwd || input.cwd,
          });
        } catch {
          taskRun = null;
        }
        const result = await runTask({
          task: task.task,
          cwd: task.cwd || input.cwd,
          writeScope: task.write_scope,
          sessionId: task.session_id,
          permissionMode: task.permission_mode || input.permission_mode || defaults.permissionMode,
          approvalPolicy: task.approval_policy || input.approval_policy || defaults.approvalPolicy,
          timeoutMs: task.timeout_ms || input.timeout_ms || defaults.timeoutMs,
          noWeb: Boolean(task.no_web || input.no_web),
          onEvent: (event) => {
            recordEvent(taskRun, event);
            onEvent({ ...event, __task: task.title || '' });
          },
          onSpawn: control.track,
        });
        runlog.finish(taskRun, {
          ok: result.ok,
          durationMs: result.durationMs,
          sessionId: result.sessionId,
          text: result.text,
          reason: control.cancelled ? '被调用方取消' : result.reason,
          usage: result.usage,
        });
        return result;
      });
      return { results, tasks, limit, wallMs: Date.now() - startedAt };
    },
  );

  if (input.mode === 'async') return textResult(renderRunning(job).text, false);
  return awaitJob(job, softWait(input), ctx);
}

async function callJob(args, ctx) {
  const input = args || {};
  const job = jobs.get(String(input.job_id || ''));
  if (!job) return textResult(`找不到作业：${input.job_id}。它可能已完成并被回收，或 id 写错了。`, true);

  if (input.action === 'cancel') {
    if (job.state !== 'running') return textResult(`作业 ${job.id} 已经结束（${job.state}），不需要取消。`, false);
    // Only this job's workers: other jobs keep running.
    job.cancelled = true;
    job.state = 'cancelled';
    job.endedAt = Date.now();
    const count = job.children.size;
    for (const child of job.children) killTree(child);
    if (job.run) runlog.finish(job.run, { ok: false, durationMs: job.endedAt - job.startedAt, reason: '被调用方取消' });
    retire(job);
    return textResult(`已取消作业 ${job.id}（终止 ${count} 个子代理进程）。`, false);
  }

  return awaitJob(job, input.wait_ms, ctx);
}

/**
 * The connecting client's plan quota, when it is running low, so the session starts
 * out delegating more. Codex: its own session logs. Claude clients: what Claude Code
 * last recorded (Claude Desktop shares that plan quota). Read once per session.
 */
function quotaNote(clientInfo) {
  try {
    const quota = require('./quota');
    const codex = String((clientInfo && clientInfo.name) || '').toLowerCase().includes('codex');
    const text = quota.advice(codex ? quota.readCodex() : quota.readClaude(), codex ? 'Codex' : 'Claude');
    return text ? `\n\n${text}` : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- protocol

function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (typeof method !== 'string') {
    if (id !== undefined) replyError(id, -32600, 'Invalid Request');
    return;
  }

  switch (method) {
    case 'initialize': {
      const requested =
        params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK;
      reply(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '把边界清楚的任务委派给本机 DeepSeek Harness 子代理：dsh_task 单发、dsh_parallel 并行、dsh_job 追长任务。' +
          quotaNote(params && params.clientInfo),
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const token = params && params._meta ? params._meta.progressToken : undefined;
      const ctx = { progressToken: token };

      if (name === 'dsh_job') {
        callJob(args, ctx).then(
          (result) => reply(id, result),
          (cause) => reply(id, textResult(`dsh_job 出错：${cause && cause.message ? cause.message : cause}`, true)),
        );
        return;
      }
      const handler = name === 'dsh_task' ? callTask : name === 'dsh_parallel' ? callParallel : null;
      if (!handler) {
        reply(id, textResult(`未知工具：${name}`, true));
        return;
      }
      handler(args, ctx).then(
        (result) => reply(id, result),
        (cause) => reply(id, textResult(`dsh-delegate 内部错误：${cause && cause.message ? cause.message : cause}`, true)),
      );
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

function serve() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          message = null;
        }
        if (message && message.jsonrpc === '2.0') handle(message);
      }
      index = buffer.indexOf('\n');
    }
  });
  const shutdown = () => {
    killAll();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { serve, TOOLS, callTask, callParallel, callJob };

// Running this file directly starts the stdio server; client configs point here.
if (require.main === module) serve();
