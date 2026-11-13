window.__ModuleLoader__.load({
  id: 'dsh-delegate',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = 'http://127.0.0.1:7788';
    const POLL_MS = 4000;

    async function get(path) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(API + path, { signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }

    function fmt(n) {
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    function Panel() {
      const [service, setService] = React.useState(null);
      const [runs, setRuns] = React.useState(null);
      const [error, setError] = React.useState('');
      const [open, setOpen] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const [svc, list] = await Promise.all([get('/api/service'), get('/api/runs')]);
            if (!alive) return;
            setService(svc);
            setRuns(list);
            setError('');
          } catch (cause) {
            if (alive) setError(cause && cause.message ? cause.message : 'unreachable');
          }
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      const running = runs ? runs.running : 0;
      const total = runs ? runs.runs.length : 0;
      const tokens = runs && runs.totals ? runs.totals.total : 0;
      const dot = error ? '#f45b69' : '#3ecf8e';

      const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 };
      const btn = {
        fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
        border: '1px solid currentColor', background: 'transparent', color: 'inherit', opacity: 0.85,
      };

      return h(
        'div',
        {
          style: {
            border: '1px solid rgba(128,128,128,.35)', borderRadius: 8,
            padding: '8px 10px', marginBottom: 6, color: 'inherit', opacity: 0.92,
          },
        },
        h(
          'div',
          { style: row },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: dot } }),
          h('strong', { style: { fontSize: 12.5 } }, 'DSH 委派'),
          h(
            'span',
            { style: { opacity: 0.7 } },
            error
              ? '服务未连接（' + error + '）'
              : '运行中 ' + running + ' · 共 ' + total + ' · Σ ' + fmt(tokens) + ' tok',
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              style: btn,
              onClick: () => setOpen((value) => !value),
            },
            open ? '收起' : '详情',
          ),
          h(
            'a',
            {
              href: API,
              target: '_blank',
              rel: 'noreferrer',
              style: { ...btn, textDecoration: 'none' },
            },
            '打开看板',
          ),
        ),
        open
          ? h(
              'div',
              { style: { marginTop: 6, display: 'grid', gap: 4 } },
              (runs && runs.runs.length
                ? runs.runs.slice(0, 6)
                : [{ id: 'none', title: '还没有运行记录', state: 'idle', toolCalls: 0 }]
              ).map((run) =>
                h(
                  'div',
                  { key: run.id, style: { ...row, opacity: 0.85 } },
                  h(
                    'span',
                    {
                      style: {
                        width: 6, height: 6, borderRadius: 3,
                        background: run.state === 'running' ? '#3ecf8e' : '#8b93a7',
                      },
                    },
                  ),
                  h(
                    'span',
                    { style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    run.title || run.id,
                  ),
                  h(
                    'span',
                    { style: { opacity: 0.6 } },
                    run.state + (run.toolCalls ? ' · ' + run.toolCalls + '×工具' : ''),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-delegate-panel', order: 40 },
            Panel,
          ),
        );
      },
    };
  },
});
