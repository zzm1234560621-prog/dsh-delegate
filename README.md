# dsh-delegate

中文 | [English](README.en.md)

**让 Claude 把机械活交给本机的 DeepSeek Harness（DSH）子代理去干。**

Claude Desktop、Claude Code、Codex 通过 MCP 多出三个工具：`dsh_task` 单发、`dsh_parallel` 并行、`dsh_job` 追长任务。Claude 负责拿主意，DSH 负责跑腿：批量改文件、写小脚本、解释报错、跑检查并汇总。这些活由更便宜的模型在独立进程和沙箱里完成，只把结论交回来，不占 Claude 的上下文。

```text
Claude Desktop / Claude Code / Codex
        │  MCP (stdio)
        ▼
  dsh-delegate ──spawn──► dsh --profile headless  × N    独立进程 · 沙箱 · 可续接
        ▲                          │
        └──── 状态行 + 结论 / job id ┘
```

## 特性

- **零依赖**：只要 Node.js 18+，没有 `npm install` 这一步。
- **长任务不会被宿主超时掐断**：调用最多等 45 秒，没跑完就先返回 `job=…`（不是失败），再用 `dsh_job` 接着等。
- **并行，且各写各的**：`dsh_parallel` 默认全部同时跑；每个任务可以带 `write_scope`，能读整个仓库，但只能写自己那块，越界写由 DSH 沙箱拒绝。
- **可续接**：状态行带 `session_id`，传回去就能接着上次的会话干。
- **用量看得见**：从 DSH 会话日志里算出每次的 token 和吞吐。
- **本机看板**：实时看子代理在干什么，在网页里切换模型、填凭据；装成 DSH 插件后，DSH 输入框上方也有一个面板。

## 前置条件

- Node.js ≥ 18
- DSH 桌面版（DSH NEXT）或 CLI（`npm i -g @deepseek-ai/dsh`），装一个即可
- 一个模型 API key，装好后在看板里配，见「配置模型和 key」

## 安装

两种装法的目的一样：把 Claude 桌面版、Claude Code、Codex 接到本机 DSH。DSH 自己派子代理用的是它内置的 subagent，不经过本工具。

| | A. 安装脚本 | B. DSH 插件 |
|---|---|---|
| 把三个客户端接到 DSH（MCP 配置） | ✓ 安装时写一次 | ✓ 每次 DSH 启动时检查，不一致才写 |
| skill 和全局分工说明（教 Claude 哪些活该派） | ✓ | — |
| `dsh` 命令行启动器 | ✓ | — |
| DSH 输入框上方的委派面板 | — | ✓ |

推荐两个都装：脚本把全套装好，插件负责以后自动校准配置、提供面板。插件会优先使用脚本部署的运行时。

### A. 安装脚本

**下载安装包，不需要 git**：到 [Releases](https://github.com/zzm1234560621-prog/dsh-delegate/releases/latest) 下载 `dsh-delegate-v*.zip` 并解压。Windows 双击 `install.cmd`，窗口会停在结果页；macOS / Linux 在解压出的目录里运行 `sh install.sh`。

**或者用 git 克隆**，Windows（PowerShell 或 cmd）：

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
.\install.cmd --dry-run    # 先看会改哪些文件
.\install.cmd
```

macOS / Linux：

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
./install.sh --dry-run
./install.sh
```

两个脚本参数相同（Windows 也认 `-DryRun`、`-Targets` 这种写法）：

| 参数 | 作用 |
|---|---|
| `--dry-run` | 只列出会改动的文件，不写入 |
| `--targets=claude-code,codex` | 只接指定的客户端（默认三个都接） |
| `--copy-credentials` | 把 DSH 里已存的 `DEEPSEEK_API_KEY` 复制到 headless 能读的 `.env` |
| `--autostart` | 登录时自动启动本机看板服务 |
| `--usage-hooks` | 给 Claude Code 加额度记录和派活提醒（会改 `~/.claude/settings.json`） |

拼错的参数会直接报错退出，不会误装。

装完后**完全退出并重开 Claude 桌面版**，或新开一个 Claude Code 会话。工具列表里出现 `dsh_task` / `dsh_parallel` / `dsh_job` 就说明装好了。还没配过 key 的话，接着按下面「配置模型和 key」在看板里配一次。以后更新时，下载新的安装包（或 `git pull`）再跑一次安装脚本即可：没有变化的配置不会被重写。

### B. DSH 插件

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"
```

装完重启该 profile。之后 DSH 每次启动都会检查三个客户端的 MCP 配置，只在不一致时才写，写之前备份。需要 PATH 上有 `node`。委派面板显示本机服务的状态，以及 Claude / Codex 派来的任务；DSH 自己的子代理不会出现在这里。不想让插件改外部客户端，就在插件配置里设 `wireClients: false`。

### 安装器会改哪些文件

| 位置 | 内容 |
|---|---|
| `~/.dsh/bridge/` | 运行时：MCP 服务、命令行、看板 |
| `dsh` 启动器 | 只在只装了桌面版、PATH 上找不到 `dsh` 时生成；已有的 `dsh` 不会被覆盖或删除 |
| `~/.dsh/skills/dsh-delegate/`、`~/.claude/skills/dsh-delegate/` | skill：哪些活值得派、任务怎么写 |
| `~/.dsh/AGENTS.md`、`~/.claude/CLAUDE.md` | 追加一段带标记的分工说明（`<!-- dsh-delegate:start -->` … `end`），重装只替换这一段 |
| Claude 桌面版配置、`~/.claude.json`、`~/.codex/config.toml` | 添加名为 `dsh` 的 MCP 服务 |
| `~/.claude/settings.json`（只在加了 `--usage-hooks` 时） | statusLine 和 UserPromptSubmit hook |

只有内容真的变了才写；写之前在同目录留一份 `*.bak-dsh-delegate-<时间>` 备份。

### 其他 MCP 客户端

Cursor、Windsurf 等支持 stdio MCP 的客户端，可以手动添加。下面这条命令会按本机路径打印好配置片段：

```bash
node ~/.dsh/bridge/bin/dsh-delegate.js print-config
```

## 配置模型和 key

headless 读不到 DSH 桌面版里保存的 key，装好后要**在看板里配一次**。

1. 打开看板。也可以点 DSH 委派面板上的「打开看板」。

   ```powershell
   node "$env:USERPROFILE\.dsh\bridge\bin\dsh-delegate.js" ui --open    # Windows
   ```

   ```bash
   node ~/.dsh/bridge/bin/dsh-delegate.js ui --open                    # macOS / Linux
   ```

2. 在「执行模型与凭据」里选模型供应商、模型和思考强度。
3. 点「用当前供应商的变量名」，在「值」里粘贴 key，点「写入 .env」。
4. 点「保存模型」，下次派活就生效。

看板会把 key 写进 `$DSH_HOME/.env`（默认 `~/.dsh/.env`），把模型写进 headless profile。换供应商也要在这里换：只改 `.env` 不会切换模型。`DSH_` 开头的变量名是 DSH 保留的，会被拒绝。

只用 DeepSeek 的话，安装时加 `--copy-credentials` 也行，它会把 DSH 里已存的 `DEEPSEEK_API_KEY` 复制到 `.env`。

## 使用

分工规则已经写进 `~/.claude/CLAUDE.md` 和 skill，Claude 会自己判断什么时候该派。也可以直接说：

```text
用 dsh 把 src/ 下 .js 的双引号统一成单引号，改完跑 npx eslint src 并汇报。
```

```text
分三路并行：a、b、c 三个模块各改各的，写边界分别是 src/a、src/b、src/c。
```

每个结果的第一行是状态行：

```text
[DSH ok · 22.4s · exit 0 · workspace-write · write:src/a · 12.3k tok（出 1.8k）· 82 tok/s · session-…]
改完 14 个文件，eslint 通过。
```

### 三个工具

| 工具 | 用途 | 常用参数 |
|---|---|---|
| `dsh_task` | 派一件自包含的任务 | `task`、`cwd`、`write_scope`、`session_id`（续接）、`mode: "async"`、`no_web` |
| `dsh_parallel` | 一次派多件互不依赖的任务 | `tasks[]`（每项可带 `title`、`write_scope`、`cwd`）、`max_concurrency` |
| `dsh_job` | 等待或取消长任务 | `job_id`、`wait_ms`、`action: "cancel"` |

- 一次调用最多等 45 秒（用 `soft_wait_ms` 调整，`0` 表示一直等）。没跑完会返回 `job=…`，**这不是失败**，用 `dsh_job` 接着等。
- 任务本身默认不设超时，显式传了 `timeout_ms` 才计时。
- 子代理能读整个仓库，只能写工作目录或 `write_scope`；默认 `workspace-write` 沙箱，无人值守（`--approval-policy never`）。
- `dsh_job` 的 `cancel` 只终止这个作业自己的子代理，连同它们启动的子进程；别的作业不受影响。

## 额度快用完时多派给 DSH

Claude Code 或 Codex 的套餐额度快用完时，dsh-delegate 提醒它们把更多活派给 DSH。

| 客户端 | 额度从哪来 | 怎么提醒 |
|---|---|---|
| Claude Code | statusline 数据里 5 小时和每周额度的已用百分比（claude.ai Pro / Max / Ultra 订阅才有）；`dsh-delegate statusline` 记到 `$DSH_HOME/quota/claude.json`，并在底栏显示额度和当前档位 | UserPromptSubmit hook（`dsh-delegate hook prompt`）在每次发消息时把提醒加进 Claude 的上下文 |
| Codex | 直接读本地会话日志 `~/.codex/sessions`，不用配置 | 每次新会话开始，MCP 服务把当时的额度和派活要求放进给 Codex 的说明里 |
| Claude 桌面版 | 与 Claude Code 共用套餐额度，取 Claude Code 最近记下的数字，可能已经过时 | MCP 服务启动时把额度和派活要求放进给 Claude 的说明里 |

不会读取任何登录令牌。

档位：任一窗口用到 70%（默认）进入「多派」：能写成自包含说明的活优先派给 DSH；用到 90%（默认）进入「全派」：除了必须自己拿主意的部分都派出去。两个阈值在看板的「额度与派活档位」卡片里改。额度不高时什么都不加。

怎么开：安装时加 `--usage-hooks`。它会在 `~/.claude/settings.json` 里加 statusLine 和这个 hook，写之前备份；如果你已经有自己的 statusLine，保留不动，只加 hook（这时 Claude 的额度没人记录，可以在自己的 statusline 脚本里把输入转给 `dsh-delegate statusline`）。查看当前额度：`dsh-delegate quota`。卸载时会一并移除它加的 statusLine 和 hook。

局限：只是很明确的提醒，派不派最终还是模型自己决定；Codex 的日志格式不是公开接口，读不到时什么都不做；Claude 桌面应用的 Code 标签可能不运行 statusline，这时只有终端里的 Claude Code 会更新数字。

## 看板与本机服务

下面的 `dsh-delegate` 指 `node ~/.dsh/bridge/bin/dsh-delegate.js`（Windows 为 `node "$env:USERPROFILE\.dsh\bridge\bin\dsh-delegate.js"`）。

```bash
dsh-delegate ui --open         # 启动服务并在浏览器打开看板：http://127.0.0.1:7788
dsh-delegate daemon --no-ui    # 只要 API，不要看板
dsh-delegate autostart on      # 登录自启动
dsh-delegate status
dsh-delegate quota             # 查看 Claude / Codex 额度和当前档位
```

服务只监听 `127.0.0.1`，只接受本机进程、本机页面（看板自己、`dsh web`）和 DSH 桌面版的请求；其他网站从浏览器发来的请求一律返回 403。如果确实需要放行别的来源，可以用环境变量 `DSH_DELEGATE_ALLOWED_ORIGINS` 追加。

服务不随 Claude 或 DSH 启动。要它一直在，就开登录自启：`dsh-delegate autostart on`。

## 自检与测试

```bash
dsh-delegate doctor --run    # 检查环境，再真跑一次（一次模型调用）
npm test                     # MCP 握手冒烟
npm run test:all             # 冒烟 + 安装/协议边界 + 回归测试，全部离线，不调用模型
node test/live.js            # 按 Claude 桌面版的真实配置走一遍完整协议（一次模型调用）
```

## 卸载

```bash
dsh-delegate uninstall --remove-runtime
dsh plugin --profile <profile> remove dsh-delegate    # 装过插件的话
```

卸载会删掉 skill、分工说明段落、自己生成的启动器、它加到 Claude Code 的 statusLine 和 hook，以及三个客户端里指向本工具的 `dsh` 条目，并关闭登录自启动。别人的同名配置不会被删。想保留客户端配置就加 `--keep-clients`。

## 已知边界

- 子代理看不到你和 Claude 的对话，任务描述必须自包含。每次调用默认是新会话，用 `session_id` 续接。
- DSH 沙箱始终放行系统临时目录（Windows 实测 `%TEMP%`），`write_scope` 管不到那里。别在临时目录里验证写边界。
- 并发默认不设上限，任务一多要注意内存和模型限流，可以用 `max_concurrency` 限制。
- Windows 是主要测试平台；macOS / Linux 上的桌面版路径发现还没有在真机上验证过。

## 常见问题

**工具列表里没有 `dsh_*`**：完全退出 Claude 桌面版（包括托盘图标）再打开，或新开 Claude Code 会话；还不行就跑 `dsh-delegate doctor`。

**返回 `MISSING_CREDENTIAL`**：headless 读不到 key，到看板「执行模型与凭据」里配，见「配置模型和 key」。

**DSH 里的委派面板显示「服务未连接」**：本机服务没在跑。跑 `dsh-delegate ui --open` 启动它，或者开登录自启。

**返回 `job=dsh-…`**：任务还在跑，用 `dsh_job` 接着等。

**看板打不开**：服务没启动，先跑 `dsh-delegate ui --open`；7788 被占用时会自动顺延到 7789 及以后的端口，以 `dsh-delegate status` 的输出为准。

## License

MIT
