# dsh-delegate

把**简单任务**从 Claude / Codex 派给本机的 **DeepSeek Harness（DSH）** 子代理执行；**难的、要判断的活留在大模型这边做**。

一条 MCP 通道 + 一份常驻分工规则 + 一个 `dsh` 命令行入口。零依赖，Windows / macOS / Linux 都能装。

```
Claude Desktop ─┐
Claude Code  ───┼─ MCP (stdio) ─→ dsh-delegate ─→ dsh --profile headless ─→ 子代理干活
Codex        ───┘                                    （可并行 3-5 个，各带写作用域）
```

## 为什么不是「直接把任务塞给 web 版」

`--profile headless` 是最瘦的 DSH profile：只挂 `base + headless`（外加你选的模型插件），没有 GUI、插件市场、桌面 UI 那一堆东西。相比之下，带一堆插件的会话每轮都要为那些插件付 prefill。

## 支持矩阵

| 宿主 | 接入方式 | 状态 |
|---|---|---|
| Claude Desktop（含 Microsoft Store 版） | `claude_desktop_config.json` → `mcpServers.dsh` | ✅ 自动 |
| Claude Code（CLI / IDE） | `claude mcp add --scope user`，失败则写 `~/.claude.json` | ✅ 自动 |
| Codex | `codex mcp add`，否则写 `~/.codex/config.toml` | ✅ 自动 |
| DSH 自己 | `~/.dsh/skills/dsh-delegate` + `~/.dsh/AGENTS.md` 常驻分工 | ✅ 自动 |
| 任何 MCP 客户端 | `node bin/dsh-delegate.js serve` | ✅ 手动 |

## 一键安装

**Windows**

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
pwsh -File install.ps1            # 加 -DryRun 先看会改什么
```

**macOS / Linux**

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
./install.sh
```

**或者用 npx（不落盘仓库）**

```bash
npx github:zzm1234560621-prog/dsh-delegate install
```

安装器会做四件事：

1. 把运行时拷到 `~/.dsh/bridge`，并在 PATH 上放一个 `dsh` 启动器；
2. 写 skill（`~/.dsh/skills/dsh-delegate`、`~/.claude/skills/dsh-delegate`）；
3. 把分工规则写进 `~/.dsh/AGENTS.md` 和 `~/.claude/CLAUDE.md`（带 `dsh-delegate:start/end` 标记，可重复执行）；
4. 把 `dsh` 这个 MCP server 注册进上面表格里的客户端（改前自动备份）。

装完：

```powershell
node ~/.dsh/bridge/bin/dsh-delegate.js doctor --run
```

`doctor` 会检查 Node、DSH 安装位置、headless profile、凭据、各客户端配置，`--run` 再实跑一次小任务。

## 三个工具

| 工具 | 用途 |
|---|---|
| `dsh_task` | 派一件任务；可带 `write_scope`、`session_id` 续接 |
| `dsh_parallel` | 一次派 2-8 件、并发执行、按编号汇总 |
| `dsh_job` | 追长任务：等待 / 查看进度 / 取消 |

### 长任务：job id 不是失败

宿主客户端通常只给一次工具调用几十秒，而真活要跑几分钟。所以：

1. `dsh_task` 最多等 `soft_wait_ms`（默认 45s）；
2. 这之内完成 → 直接返回答复；
3. 没完成 → 返回 `[DSH 运行中 · 40.2s · job=dsh-xxxx]`，**这不是失败**；
4. `dsh_job({ job_id: "dsh-xxxx" })` 继续等（每次最多再等 45s），直到 `state=done/failed`；
5. 也可以一开始就 `mode: "async"`，立刻拿 job id。

作业期间服务器会按 `notifications/progress` 发进度（工作到第几轮、正在调用什么工具），宿主支持的话就能看到子代理一样的活动流。

## 并行 + 写作用域

几个子代理共享同一个仓库：**都能读整个仓库（相互查看），但只能写自己的目录**。给每个任务一个 `write_scope`（相对 `cwd` 的已存在子目录），DSH 的沙箱会把写边界收缩到那里。

```
dsh_parallel({
  tasks: [
    { title: "改 a 模块", write_scope: "src/a", task: "只改当前目录……" },
    { title: "改 b 模块", write_scope: "src/b", task: "只改当前目录……" }
  ],
  max_concurrency: 2
})
```

实测行为：

| 动作 | 结果 |
|---|---|
| 读 `write_scope` 外的文件 | 允许 |
| 文件写入工具写 `write_scope` 外 | 拒绝：`[sandbox: file access denied under workspace-write mode]` |
| pwsh / bash 写 `write_scope` 外 | 拒绝（ACL / E_ACCESSDENIED） |
| 写 `%TEMP%` / `/tmp` | 永远允许（系统临时区不在围栏内，别拿它当仓库测作用域） |
| `git commit` | 越界（`.git` 在仓库根）→ 由上层提交 |

要并行改同一批文件：给每个任务一个 `git worktree`，或者串行。

## 凭据

headless profile **不读**桌面版的凭据库，只从启动环境、`<cwd>/.env`、`$DSH_HOME/.env` 取 API key。

```powershell
# 从 DSH 已有的凭据里复制（安装时）
pwsh -File install.ps1 -CopyCredentials

# 或者手写
"DEEPSEEK_API_KEY=sk-..." | Add-Content "$env:USERPROFILE\.dsh\.env"
```

⚠️ **`DSH_` 开头的变量不能写进 `.env`**（它们被保留为启动环境变量，写了会直接报错）。所以 provider 插件如果要求 `apiKeyEnv`，用非保留名，例如：

```yaml
# ~/.dsh/profiles/headless/cordis.patch.yml
- id: opencode-go
  name: dsh-opencode-go
  config:
    accounts:
      - id: 4acc45f0db5c01cfaaa39d072aff38e5
        name: "1"
        apiKeyEnv: OPENCODE_GO_ACCOUNT_KEY   # ← 不是 DSH_ 开头
    apiKeyEnv: OPENCODE_GO_ACCOUNT_KEY
```

## 换执行模型

headless 默认走 `deepseek-official / deepseek-flash`。想换成别的路由，改 `~/.dsh/profiles/headless/cordis.patch.yml`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: dsh-opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
```

改完 `node bin/dsh-delegate.js doctor --run` 验证一次。

## 命令行入口

安装器会放一个 `dsh` 启动器（Windows 在 `%APPDATA%\npm\dsh.cmd`，POSIX 在 `~/.local/bin/dsh`）：

```powershell
dsh --profile headless "解释一下这个报错：……"
'git diff' | dsh --profile headless
dsh --profile headless --json "任务"                  # 事件流，开头带 sessionId
dsh --profile headless --session-id session-… "接着改"
dsh --profile headless --permission-mode danger-full-access "任务"
```

## 安全边界

- 子代理**无人值守**：`--approval-policy never`，需要人工审批的调用直接被拒，不会挂住。
- 默认 `workspace-write`：只能写工作目录（或 `write_scope`）之内的文件。
- 安装器只写配置文件，改前一律备份（`*.bak-dsh-delegate-<时间戳>`）；`--dry-run` 可先看清单。
- 不复制、不上传任何密钥：`--copy-credentials` 只在本机内搬运 `DEEPSEEK_API_KEY`。

## 卸载

```powershell
node bin/dsh-delegate.js uninstall --remove-runtime
```

然后按需删除客户端配置里的 `mcpServers.dsh` / `[mcp_servers.dsh]`，以及 `~/.dsh/AGENTS.md`、`~/.claude/CLAUDE.md` 里带标记的那一段（`uninstall` 已自动删）。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 客户端里看不到工具 | 改完配置要重启宿主；Claude Desktop 从托盘退出再开 |
| 调用立刻失败，`DSH_NOT_FOUND` | 设 `DSH_DELEGATE_APP` 指向桌面版可执行文件，或装 `@deepseek-ai/dsh` 让 `dsh` 进 PATH |
| 报 `MISSING_CREDENTIAL` | headless 找不到 API key：补 `$DSH_HOME/.env` 或用 `--copy-credentials` |
| 报 `.env sets "DSH_..."` | `DSH_` 前缀变量不能放 `.env`，换成非保留名（见上文） |
| 调用「超时」但 DSH 还在跑 | 用 `dsh_job` 追，别重派；`soft_wait_ms` 可调 |
| 子代理写不了别的目录 | 这是设计：写边界 = 它的工作目录 / `write_scope` |

## English quickstart

`dsh-delegate` exposes a local [DeepSeek Harness](https://github.com/deepseek-ai) install to MCP hosts (Claude Desktop,
Claude Code, Codex) so a strong model can offload mechanical work to a cheap local subagent.

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate && cd dsh-delegate
./install.sh                       # Windows: pwsh -File install.ps1
node bin/dsh-delegate.js doctor --run
```

Tools: `dsh_task` (one task), `dsh_parallel` (fan-out with per-task `write_scope`), `dsh_job` (poll long runs).
Long tasks return a job id instead of timing out; poll `dsh_job` until `state=done`.
Everything is zero-dependency Node ≥18 and writes only to config files (backed up first).

## License

MIT
