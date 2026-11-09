# 上架 DSH 插件市场：现在到哪一步了

## 已经准备好的

`plugin/` 是一个完整的、可安装的 **configuration-only bundle**：

```text
plugin/
├─ package.json        # dsh.bundle.patch + locale/icon 导出
├─ cordis.patch.yml    # insert @deepseek-ai/dsh-mcp-client（stdio）
├─ server/lib/*.js     # 打包好的 MCP 服务（零依赖）
├─ locale/{en,zh}.json # 市场展示用的标题/描述
└─ icon.svg
```

本地已验证：

- `cordis.patch.yml` 能被 js-yaml 解析，`insert` 行的 `serverName/transport/command/args/env` 都正确；
- 路径表达式两条分支都跑通：profile 安装在 `<profile>/node_modules/...`，回退到 `$DSH_HOME/bridge/lib/mcp.js`；
- 打包进去的 `server/lib/mcp.js` 能被直接拉起并完成 MCP 握手。

本地安装（不需要发布）：

```bash
dsh plugin --profile <profile> add "file:C:/path/to/dsh-delegate/plugin"
# 然后重启该 profile
```

## 上架需要的三步（需要你决定/提供）

1. **仓库公开**（现在还是 private）。市场条目里的 `install` 命令通常是
   `dsh plugin --profile web add github:<owner>/<repo>`，private 仓库装不了。
2. **发布 npm 包**（可选但更好）：
   ```bash
   cd plugin
   npm publish --access public
   ```
   发布后安装命令变成 `dsh plugin --profile web add dsh-delegate`，比 git 安装快得多。
3. **进入目录**：市场数据来自 <https://awesome-dsh-plugin.com/plugins.json>
   （9714 条），由 GitHub 仓库信息 + npm 信息汇总。需要：
   - 仓库加 topic：`dsh`、`dsh-plugin`、`deepseek-harness`；
   - README 里有清晰的安装段和截图；
   - 向目录站提交（它的站点/仓库有提交入口，通常是 issue/PR 加一行插件信息）。

我没有你的 npm 凭据，也不该擅自把仓库转公开，所以这三步留给你确认后执行。

## 我可以接着做的

- 把 `plugin/` 单独拆成一个发布用的包（含 `LICENSE`、`files` 校验、`npm pack` 干跑）；
- 写一份英文 README（市场条目里 `description.en` 用它）；
- 仓库公开后，用 `gh` 创建 release、打 tag、把安装命令写进市场提交材料；
- 或者现在直接把它装进你的 desktop profile（要重启 DSH 才生效）。
