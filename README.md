# dsh-delegate

**让 Claude 把机械活交给本机的 DeepSeek Harness（DSH）去干，自己只做判断。**

Claude 擅长规划、拆解、审阅；但「批量改 200 个文件的引号」「跑一遍测试并汇总」「把这段报错查清楚」这类活，既费它的上下文，又费钱。这台机器上已经有一个能读文件、能跑命令、能改代码的 DSH，缺的只是一条让 Claude 把活递过去的通道。

dsh-delegate 就是这条通道：一个 MCP 服务 + 一套运行机制 + 一个能看到子代理在干什么的看板。

```
┌──────────────┐   MCP(stdio)   ┌──────────────┐   spawn    ┌───────────────────┐
│ Claude       │ ─────────────► │ dsh-delegate │ ─────────► │ dsh --profile     │
│ Desktop/Code │  dsh_task      │  (本仓库)     │  一次一个   │ headless "<任务>"  │
│ Codex        │ ◄───────────── │              │ ◄───────── │ 子代理：读写/执行   │
└──────────────┘  结果/job id    └──────┬───────┘   结果      └───────────────────┘
                                        │ 运行记录（zstd）
                                        ▼
                              ┌────────────────────┐
                              │ 看板 / DSH 页内面板 │
                              └────────────────────┘
```

## 它解决的具体问题

| 问题 | dsh-delegate 的做法 |
|---|---|
| 宿主工具调用只有几十秒耐心，真活要几分钟 | 异步作业：先返回 `job=…`，用 `dsh_job` 轮询，**长任务不会被掐断** |
| 一个任务要跑很多步（查证、改文件、跑测试） | 每个任务独立进程、独立沙箱，互不干扰 |
| 多个互不依赖的活排队太慢 | 并行分发，**默认不限制并发**，一次全放出去 |
| 多个子代理改同一个仓库会互相覆盖 | `write_scope`：读全仓、只写自己那块（DSH 沙箱强制） |
| 不知道子代理在干嘛、花了多少钱 | 实时事件流 + 每个任务的 token / 吞吐统计 |
| 只想要结论，不想让便宜的活污染主上下文 | 结果只回一段最终答复，过程留在看板 |

## 它是怎么实现的

**1. MCP over stdio（`lib/mcp.js`，零依赖）**
一个几十行的 JSON-RPC 服务，暴露三个工具：`dsh_task`、`dsh_parallel`、`dsh_job`。Claude / Codex 通过 `mcpServers` 配置拉起它，不需要网络、不需要守护进程。

**2. 每次任务 = 一个 headless 进程（`lib/dsh.js`）**
调用 `dsh --profile headless`，任务从 stdin 传入，输出用 `--json` 逐行事件流解析。选 headless 是因为它是最瘦的 profile（只有 base + headless），没有 GUI、市场、桌面插件那一堆 prefill。启动方式有三种：桌面版（Electron 的 Node 模式 + `desktop-cli.js`）、PATH 上的 `dsh`、或显式 `--dsh-app`。

**3. 异步作业（解决宿主超时）**
`dsh_task` 最多等 `soft_wait_ms`（默认 45s）。这之内完成就直接返回答复；没完成就返回一行 `[DSH 运行中 · 40.2s · job=dsh-xxxx]` —— **这不是失败**，上层用 `dsh_job` 继续等，每次再等一段。作业状态在服务进程内维护，同时把事件写进运行记录供看板读取。

**4. 并行与写作用域**
`dsh_parallel` 用一个并发池把 N 个任务同时跑起来（池大小可设，0 = 不限）。每个任务可以带 `write_scope`：把子代理的工作目录收缩到仓库里的一个子目录。DSH 沙箱的写边界就是会话 cwd，所以「读全仓、只写自己那块」是**强制**的，不是提示词约定。

**5. token 统计（`lib/usage.js`）**
每个子代理的用量来自它自己的 session 日志（`~/.dsh/sessions/**/session.v4.jsonl.zstd`）。这文件是**多帧 zstd 拼接**，Node 的同步解压只读第一帧，所以按帧头拆分逐帧解压，累加每条 `assistant/message` 里的 provider usage，得出输入/输出/缓存/总量，再除以墙钟得到吞吐。

**6. 看板与面板**
- 独立看板：本机 HTTP 服务（`lib/ui.js` + `assets/ui.html`），默认 `127.0.0.1:7788`，管模型/凭据/派活默认值/运行记录/自检；
- DSH 页内面板：一个客户端插件（`plugin/client.js`）注册在输入框上方，轮询同一套 API（已加 CORS）。

**7. 部署（`bin/dsh-delegate.js`）**
先发现 DSH（常见安装目录 → 扫描含 `app.asar` 的应用目录 → PATH 上的 `dsh`），把运行时**先写临时目录再原子替换**到 `~/.dsh/bridge`（中断不会留下半成品），然后写启动器、skill、全局指令、三个客户端配置，最后**真的拉起一次 MCP 服务做握手自检**，失败就以非 0 退出。

**8. DSH 插件形态（`plugin/`）**
一个 configuration-only bundle：`cordis.patch.yml` 插入一个 host plugin；它在 DSH 启动时把 Claude/Codex 的 MCP 配置写好（幂等、写前备份），并注册页内面板。DSH 自己的 `subagent` 能力完全不动——这个插件不往 DSH 里插 MCP 客户端。

## 两种安装方式

两者任选其一即可，也可以都装（互不冲突）。

| 你主要用什么 | 装哪个 | 装完谁获得能力 |
|---|---|---|
| Claude 桌面版 / Claude Code / Codex | **一键脚本** | Claude 侧出现 `dsh_task` 等工具 |
| DSH（Web / Desktop） | **DSH 插件** | 插件顺手把 Claude 也接上，并在 DSH 页面出现面板 |

### 一键脚本

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate; cd dsh-delegate
install.cmd                      # Windows（自动挑 pwsh / powershell；双击也行）
```

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate && cd dsh-delegate
./install.sh                     # macOS / Linux
```

没有 `install.cmd` 时：`powershell -ExecutionPolicy Bypass -File install.ps1`。

参数：`--dry-run` 只看不改；`--no-clients` 只装本地；`--copy-credentials` 从 DSH 已有凭据复制 key。

### DSH 插件

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"   # 本地目录（已实测）
dsh plugin --profile <profile> add dsh-delegate                          # npm 发布后
dsh plugin --profile <profile> add "github:zzm1234560621-prog/dsh-delegate#path:/plugin"  # 仓库公开后
```

装完重启该 profile。要求 DSH ≥ 0.2.1-rc.5。想只装 DSH 侧、不碰外部客户端，设 `wireClients: false`。

## 用起来是什么样

Claude 侧不需要你教它，指令文件里已经写好了分工规则（`~/.dsh/AGENTS.md`，脚本安装时写入）：

> 简单、自包含的活派给 DSH；难的、要拿主意、要你亲自审的活自己做。

你也可以直接说：

```
用 dsh 把 src/ 下所有 .js 的双引号统一成单引号，只改这些文件，改完跑 npx eslint src 并汇报。
分三路并行：a 模块、b 模块、c 模块，各改各的目录。
```

返回长这样：

```
[DSH ok · 22.4s · exit 0 · workspace-write · write:src/a · 12.3k tok（出 1.8k）· 82 tok/s · session-…]
改完 14 个文件，eslint 通过。
```

## 三个工具

| 工具 | 说明 |
|---|---|
| `dsh_task` | 派一件任务。可带 `write_scope`、`session_id` 续接、`no_web` 断网、`timeout_ms`（默认不设） |
| `dsh_parallel` | 一次派多件，并发执行并按编号汇总；`max_concurrency` 默认 0 = 不限制 |
| `dsh_job` | 等待 / 查看 / 取消一个作业 |

**长任务**：看到 `job=…` 不是失败，用 `dsh_job` 接着等。
**超时**：默认没有超时，跑完为止；只有显式传 `timeout_ms` 才会计时并终止。
**写作用域**：子代理能读整个仓库，只能写自己的工作目录或 `write_scope`；越界会被沙箱拒绝（`[sandbox: file access denied]`）。

## 看板

```bash
dsh-delegate daemon            # 常驻服务 + 看板   http://127.0.0.1:7788
dsh-delegate daemon --no-ui    # 只跑服务
dsh-delegate autostart on      # 登录自启动
dsh-delegate status
```

看板里能改：执行模型（近 40 个供应商，模型列表从 DSH 内置目录实时读取）、思考强度、凭据、沙箱模式与审批策略、等待/超时/并发/存储上限；能看：每个子代理的实时事件流、tokens 与吞吐、磁盘占用。

## 凭据

headless profile **不读**桌面版凭据库，只读启动环境、`<cwd>/.env`、`$DSH_HOME/.env`：

```powershell
"DEEPSEEK_API_KEY=sk-..." | Add-Content "$env:USERPROFILE\.dsh\.env"
```

⚠️ `DSH_` 开头的变量名不能写进 `.env`（被保留为启动环境变量）。

## 验证与测试

```bash
node ~/.dsh/bridge/bin/dsh-delegate.js doctor --run   # 服务端自检，真跑一次
node test/live.js                                    # 按 Claude 的真实配置走完整协议
node test/edge.js                                    # 28 项故障注入（隔离 HOME，不碰真实配置）
```

`test/edge.js` 覆盖：全新机器安装、损坏的客户端配置（不覆盖用户数据）、DSH 缺失、重复安装幂等、越界/不存在的 `write_scope`、空任务、未知工具/方法、100KB 任务、并发请求、垃圾输入。

## 已知边界

- 子代理是**一次性的**：每次任务一个新会话，除非用 `session_id` 续接；
- 它看不到你和 Claude 的对话，任务必须自包含；
- 并行不限制并发 = 可以开很多进程，注意内存与供应商限流；
- 运行记录默认不限制磁盘增长，看板里可以设上限；
- macOS / Linux 的桌面版路径发现是尽力而为，未在真机验证。

## 卸载

```bash
node bin/dsh-delegate.js uninstall --remove-runtime   # 脚本安装的
dsh plugin --profile <profile> remove dsh-delegate    # 插件安装的
```

## License

MIT
