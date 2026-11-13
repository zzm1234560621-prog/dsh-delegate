# dsh-delegate

让 **Claude Desktop / Claude Code / Codex** 调用本机的 **DeepSeek Harness（DSH）** 执行任务；同时在 DSH 页面里提供一个运行面板。

- 把机械活派出去：批量改文件、生成脚本/正则、解释报错、跑检查并汇总；
- 并行分发、按任务限定写作用域、长任务用 job 轮询（不会被宿主的工具超时打断）；
- 零依赖 MCP 服务 + 本地看板 + DSH 页内面板。

```
Claude Desktop ─┐
Claude Code  ───┼─ MCP(stdio) ─→ dsh-delegate ─→ dsh --profile headless ─→ 子代理执行
Codex        ───┘                                   （可并行 / 限定写范围 / 统计 token）
```

## 两种安装方式

两种方式**任选其一**，也可以都装（互不冲突）。

| 你主要用什么 | 选哪个 | 装完谁获得能力 |
|---|---|---|
| Claude 桌面版 / Claude Code / Codex | **方式 A：一键脚本** | Claude 侧出现 `dsh_task` 等工具 |
| DSH（Web / Desktop） | **方式 B：DSH 插件** | 插件自动帮你把 Claude 也接上，并在 DSH 页面出现面板 |

---

### 方式 A：一键脚本（给只用 Claude 的人）

**Windows**

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
install.cmd                 # 自动挑 pwsh / powershell，双击也行
```

没有 `install.cmd` 时用：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1     # 没装 PowerShell 7 时
pwsh -File install.ps1                                   # 装了 PS7 时
```

**macOS / Linux**

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
./install.sh
```

脚本会做这些事（全程自动备份）：

1. 找到本机 DSH（桌面版安装目录 → PATH 上的 `dsh` → `--dsh-app` 显式指定）；
2. 把运行时部署到 `~/.dsh/bridge`，并在 PATH 放一个 `dsh` 启动器；
3. 写 skill（`~/.dsh/skills`、`~/.claude/skills`）和全局指令（`AGENTS.md` / `CLAUDE.md`）；
4. 把 `dsh` 这个 MCP server 写进 **Claude 桌面版 / Claude Code / Codex** 的配置；
5. 自检一次（真的拉起 MCP 服务并完成握手，失败会以非 0 退出）。

常用参数：`--dry-run` 只看不改；`--no-clients` 只装本地不碰客户端；`--copy-credentials` 从 DSH 已有凭据复制 API key。

---

### 方式 B：装成 DSH 插件（给 DSH 用户）

插件是一个 configuration-only bundle，装进某个 profile 后：

- 启动时**自动把 Claude Desktop / Claude Code / Codex 接到本机 DSH**（幂等、写前备份）；
- 在 DSH 页面输入框上方注册一个**委派面板**（服务状态、运行中数量、token 合计、最近运行）；
- DSH 自己的子代理能力不受影响（`subagent` / `subagent_workflow` 照旧）。

**本地目录安装**（已实测）：

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"
```

**发布到 npm 之后**：

```bash
dsh plugin --profile <profile> add dsh-delegate
```

**仓库公开后从 GitHub 装**：

```bash
dsh plugin --profile <profile> add "github:zzm1234560621-prog/dsh-delegate#path:/plugin"
```

装完**重启该 profile**（Desktop 版：退出应用再打开）。想关掉对外接线，在插件配置里设 `wireClients: false`。

> 要求：DSH ≥ 0.2.1-rc.5（会用到 `@deepseek-ai/dsh-mcp-client`）。

---

## 装完怎么验证

```bash
# 1. 服务端自检（真跑一次任务）
node ~/.dsh/bridge/bin/dsh-delegate.js doctor --run

# 2. 按 Claude 的真实配置走一遍协议（initialize → tools/list → dsh_task）
node test/live.js

# 3. Claude 里直接问
#    「用 dsh 数一下当前目录有多少个 .md 文件」
```

看到 `[DSH ok · … · 7.2k tok …]` 这样的状态行就说明通了。

## 三个工具

| 工具 | 用途 |
|---|---|
| `dsh_task` | 派一件任务；可带 `write_scope`、`session_id` 续接、`no_web` 断网 |
| `dsh_parallel` | 一次派多件、并发执行、按编号汇总（**不限制并发**） |
| `dsh_job` | 追长任务：等待 / 查看进度 / 取消 |

**长任务**：`dsh_task` 默认最多等 45s，没跑完会返回 `job=dsh-xxxx` —— **那不是失败**，用 `dsh_job` 继续等即可。运行本身默认**没有超时**（不设上限，跑完为止），只有显式传 `timeout_ms` 才计时。

**并行**：默认 `max_concurrency = 0`，也就是全部同时跑。每个子代理是一个进程，开很多时注意内存。

**写作用域**：子代理能读整个仓库，但只能写自己的工作目录 / `write_scope` 内；越界写会被 DSH 沙箱拒绝。

## 本地看板与 DSH 面板

```bash
dsh-delegate daemon            # 常驻服务 + 看板   http://127.0.0.1:7788
dsh-delegate daemon --no-ui    # 只跑服务（/api/* 仍可用）
dsh-delegate autostart on      # 登录自启动
dsh-delegate status
```

看板里有：执行模型（39 个供应商，模型列表从 DSH 内置目录实时读取）、思考强度、凭据、派活默认值（沙箱/审批/等待/并发/存储）、子代理实时看板、自检、客户端接入状态、按条目的 token 与吞吐统计。

## 凭据

headless profile **不读**桌面版凭据库，只读：启动环境、`<cwd>/.env`、`$DSH_HOME/.env`。

```powershell
"DEEPSEEK_API_KEY=sk-..." | Add-Content "$env:USERPROFILE\.dsh\.env"
```

⚠️ **`DSH_` 开头的变量名不能写进 `.env`**（被保留为启动环境变量），provider 插件要 key 时请用非保留名。

## 测试

```bash
node test/smoke.js     # MCP 握手 + 工具清单
node test/edge.js      # 28 项：全新机器安装、损坏配置、协议边界、极端输入
node test/live.js      # 按 Claude 真实配置端到端跑一次（花一次模型调用）
```

`test/edge.js` 全部在隔离的 `HOME / USERPROFILE / APPDATA / LOCALAPPDATA` 里跑，不会碰你的真实配置。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| Claude 报 `dsh couldn't start` | 入口没自启动（旧版本 bug，已修）；或配置指向的路径被删。`node test/live.js` 可复现验证 |
| `MISSING_CREDENTIAL` | headless 找不到 key，补 `$DSH_HOME/.env` 或用 `--copy-credentials` |
| 报 `.env sets "DSH_..."` | `DSH_` 前缀变量不能放 `.env`，换名 |
| 任务跑了很久 | 默认没有超时；用 `dsh_job` 看进度，或 `action:"cancel"` |
| 子代理写不了别的目录 | 设计如此：写边界 = 工作目录 / `write_scope` |
| 看板空白 | 服务没起来或 CORS 未部署；页面顶部会有断线提示并自动重连 |

## 卸载

```bash
node bin/dsh-delegate.js uninstall --remove-runtime   # 脚本安装的
dsh plugin --profile <profile> remove dsh-delegate    # 插件安装的
```

## License

MIT
