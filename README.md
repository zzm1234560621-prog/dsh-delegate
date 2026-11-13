# dsh-delegate

**让 Claude 把机械活交给本机的 DeepSeek Harness（DSH）去干。**

Claude 负责判断，DSH 负责跑腿：批量改文件、生成脚本、解释报错、跑检查并汇总。通道是一个 MCP 服务，外加一个能看到子代理在干什么的看板。

```
Claude Desktop/Code/Codex ──MCP(stdio)──► dsh-delegate ──spawn──► dsh --profile headless
                              ▲                                   （独立进程 / 沙箱 / 可续接）
                              └────────── 结果 + job id ◄─────────┘
```

## 怎么实现的

- **MCP over stdio**（`lib/mcp.js`，零依赖）：三个工具 `dsh_task` / `dsh_parallel` / `dsh_job`。
- **每次任务 = 一个 headless 进程**（`lib/dsh.js`）：最瘦的 profile，没有 GUI/市场那堆 prefill。
- **异步作业**：调用最多等 45s，没跑完返回 `job=…` —— **不是失败**，用 `dsh_job` 继续等，长任务不会被宿主超时掐断。
- **并行**：默认不限制并发；每个任务可带 `write_scope`，读全仓、只写自己那块（DSH 沙箱强制）。
- **统计**：从 session 日志（多帧 zstd）解出每个任务的 token 与吞吐。
- **看板 / DSH 面板**：本机 HTTP 服务 + 页内客户端插件，实时看事件流、成本、改配置。

## 安装（两种，任选其一）

**A. 一键脚本**（给用 Claude 的人）

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate; cd dsh-delegate
install.cmd          # Windows；macOS/Linux 用 ./install.sh
```

会把运行时装到 `~/.dsh/bridge`、放 `dsh` 启动器、写 skill 与全局指令、把 MCP 配置写进 **Claude 桌面版 / Claude Code / Codex**，最后自检握手。改前自动备份；`--dry-run` 只看不改。

**B. DSH 插件**（给 DSH 用户）

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"
# npm 发布后：dsh plugin --profile <profile> add dsh-delegate
```

装完重启 profile。插件会顺手把 Claude/Codex 也接上，并在 DSH 输入框上方加一个委派面板；DSH 自己的子代理不受影响。

| 你主要用什么 | 装哪个 |
|---|---|
| Claude 桌面版 / Claude Code / Codex | A |
| DSH | B（顺带把 Claude 也接上） |

## 使用

分工规则已经写进 `~/.dsh/AGENTS.md`，也可以直接说：

```
用 dsh 把 src/ 下 .js 的双引号统一成单引号，改完跑 npx eslint src 并汇报。
分三路并行：a 模块、b 模块、c 模块，各改各的。
```

返回：

```
[DSH ok · 22.4s · exit 0 · workspace-write · write:src/a · 12.3k tok（出 1.8k）· 82 tok/s · session-…]
改完 14 个文件，eslint 通过。
```

- 看到 `job=…` 就用 `dsh_job` 接着等；运行默认**没有超时**，只有显式传 `timeout_ms` 才计时。
- 子代理能读整个仓库，只能写工作目录 / `write_scope`，越界会被沙箱拒绝。

## 看板与验证

```bash
dsh-delegate daemon          # http://127.0.0.1:7788
dsh-delegate autostart on
node ~/.dsh/bridge/bin/dsh-delegate.js doctor --run   # 真跑一次自检
node test/live.js                                    # 按 Claude 真实配置走完整协议
node test/edge.js                                    # 28 项故障注入（隔离环境）
```

## 凭据

headless 只读启动环境、`<cwd>/.env`、`$DSH_HOME/.env`（不读桌面版凭据库）：

```powershell
"DEEPSEEK_API_KEY=sk-..." | Add-Content "$env:USERPROFILE\.dsh\.env"
```

`DSH_` 开头的变量名不能写进 `.env`。

## 已知边界

子代理是一次性会话（用 `session_id` 续接）；它看不到你与 Claude 的对话，任务要自包含；并发不限，注意内存与限流；macOS/Linux 的桌面版发现未在真机验证。

## 卸载

```bash
node bin/dsh-delegate.js uninstall --remove-runtime
dsh plugin --profile <profile> remove dsh-delegate
```

MIT
