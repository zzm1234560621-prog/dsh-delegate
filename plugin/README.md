# DSH Delegate（插件包）

把这个 bundle 装进一个 DSH profile 后，会发生两件事：

1. **对外接线**：DSH 启动时把 **Claude Desktop / Claude Code / Codex** 的 MCP 配置写成指向本机
   dsh-delegate 服务（幂等、写前备份）。所以「在 DSH 里装个插件」就够让 Claude 调 DSH，
   不用再跑安装脚本。
2. **页内面板**：在 DSH 输入框上方注册一个面板，显示服务状态、运行中数量、token 合计和最近运行，
   并可以一键打开完整看板。

DSH 自己的子代理（`subagent` / `subagent_workflow`）不受影响——这个插件不会往 DSH 里插 MCP 客户端。

## 安装

```bash
# 本地目录
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"

# 发布到 npm 之后
dsh plugin --profile <profile> add dsh-delegate

# 仓库公开后
dsh plugin --profile <profile> add "github:zzm1234560621-prog/dsh-delegate#path:/plugin"
```

装完重启该 profile。

## 配置

```yaml
- id: dsh-delegate-bootstrap
  name: dsh-delegate
  config:
    wireClients: true      # false = 只装 DSH 侧，不写任何外部客户端配置
```

## 要求

- DSH ≥ 0.2.1-rc.5
- 一个 headless 能读到的 API key：`$DSH_HOME/.env` 或启动环境（`DEEPSEEK_API_KEY` 等）
- 对外接线需要本机有 `node`（会在 PATH 里找；也可以用 `DSH_DELEGATE_NODE` 指定）

## 目录

| 路径 | 作用 |
|---|---|
| `cordis.patch.yml` | 只插入 `dsh-delegate-bootstrap` 一行 |
| `index.js` | host plugin：解析 node / MCP 服务路径，写三个客户端配置 |
| `client.js` | 页内面板（`conversation.composer.dock`） |
| `server/lib/` | 打包好的 MCP 服务（零依赖） |
| `locale/*.json`、`icon.svg` | 市场展示资源 |

## License

MIT
