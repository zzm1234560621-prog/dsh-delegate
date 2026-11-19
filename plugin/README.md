# DSH Delegate（插件包）

把这个 bundle 装进 DSH，装出来的和[安装包](https://github.com/zzm1234560621-prog/dsh-delegate#安装)一样：

1. **全套安装**：DSH 启动时，插件用自己带的运行时（`server/`）跑一遍安装，装好这些：
   - `~/.dsh/bridge` 运行时；
   - skill 和分工说明；
   - `dsh` 启动器；
   - **Claude Desktop / Claude Code / Codex** 的 MCP 配置（幂等，写前备份）。

   之后只在插件比 bridge 新时才重装，平时只核对客户端配置。
2. **本机服务**：没在运行就拉起来。看板（配模型和 key）和面板都要用它。
3. **页内面板**：在 DSH 输入框上方注册一个面板，显示服务状态、运行中数量、token 合计和最近运行，并可以一键打开完整看板。

DSH 自己的子代理（`subagent` / `subagent_workflow`）不受影响：这个插件不会往 DSH 里插 MCP 客户端。每次启动的过程记在 `$DSH_HOME/delegate-plugin.log`。

## 安装

在 DSH 的插件市场里搜 dsh-delegate。也可以用命令行：

```bash
# 本地目录
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"

# GitHub
dsh plugin --profile <profile> add "github:zzm1234560621-prog/dsh-delegate#path:/plugin"
```

装完重启 DSH。装好后，在看板的「执行模型与凭据」里配一次模型和 key。

## 配置

```yaml
- id: dsh-delegate-bootstrap
  name: dsh-delegate
  config:
    wireClients: true    # 写 Claude 桌面版 / Claude Code / Codex 的配置
    startService: true   # DSH 启动时拉起本机服务（面板和看板要用）
    autostart: false     # 登录时启动服务、停了自动拉起，同 install --autostart
    usageHooks: false    # Claude Code 的额度提醒，同 install --usage-hooks
```

## 要求

- DSH ≥ 0.2.1-rc.5
- Node：依次用 `DSH_DELEGATE_NODE`、PATH 上的 `node`；都没有就用 DSH 自带的 Node
- 一个 headless 能读到的 API key：在看板里配，或写进 `$DSH_HOME/.env`

## 目录

| 路径 | 作用 |
|---|---|
| `cordis.patch.yml` | 只插入 `dsh-delegate-bootstrap` 一行 |
| `index.js` | host plugin：找 Node、按需安装、核对三个客户端配置、拉起本机服务 |
| `client.js` | 页内面板（`conversation.composer.dock`） |
| `server/` | 完整运行时（`lib/`、`bin/`、`assets/`，零依赖），由 `npm run sync:plugin` 从仓库同步 |
| `locale/*.json`、`icon.svg` | 市场展示资源 |

## License

MIT
