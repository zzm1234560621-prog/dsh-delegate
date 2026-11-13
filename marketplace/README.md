# 上架 DSH 插件市场：材料已备好，只差公开

目录站：<https://awesome-dsh-plugin.com>（收录 10778 个插件）
投稿规则：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

## 现在的状态

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | ✅ `plugin/package.json` |
| 仓库内有 `cordis.patch.yml` | ✅ `plugin/cordis.patch.yml` |
| 仓库创建满 1 天 | ✅ 2026-11-09 创建 |
| 仓库带 `dsh-plugin` topic | ✅ 已加 |
| 仓库公开 | ⬜ **待你决定** |
| 条目文件 | ✅ `marketplace/awesome-dsh-plugin-entry.yml` |

## 公开后一条龙

```powershell
cd C:\Users\zzm12\Documents\deepseek-harness\default-workspace\dsh-delegate

# 1. 转公开
gh repo edit zzm1234560621-prog/dsh-delegate --visibility public --accept-visibility-change-consequences

# 2. fork + clone 目录仓库
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 3. 放入条目（文件名按 monorepo 子包规则）
Copy-Item ..\dsh-delegate\marketplace\awesome-dsh-plugin-entry.yml `
  .\data\plugins\zzm1234560621-prog__dsh-delegate--plugin.yml

# 4. 开 PR
git checkout -b add-dsh-delegate-plugin
git add data/plugins/zzm1234560621-prog__dsh-delegate--plugin.yml
git commit -m "Add zzm1234560621-prog/dsh-delegate (plugin subpackage)"
git push -u origin add-dsh-delegate-plugin
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin `
  --title "Add zzm1234560621-prog/dsh-delegate" `
  --body "MCP bridge that lets Claude Desktop / Claude Code / Codex call a local DeepSeek Harness, plus a panel inside the DSH web UI. Manifest: plugin/package.json (dsh.bundle.patch)."
```

CI 会校验：仓库年龄、manifest、YAML 格式、README 能否重新生成。
维护者合并前会读代码，确认描述属实。

## 备选：走 npm（更快，也不依赖仓库可见性）

```powershell
cd plugin
npm publish --access public     # 需要你的 npm 凭据
```

发布后用户可以直接 `dsh plugin --profile <p> add dsh-delegate`，
市场条目里的 `install` 也会变成 npm 安装，比 git 拉取快。

## 描述里的数字要能对上

条目里写的是「Claude Desktop / Claude Code / Codex」三种客户端 + 一个 DSH 面板，
对应的实现分别在：

- `plugin/index.js` → `targets.applyAll(['claude-desktop','claude-code','codex'])`
- `plugin/client.js` → `conversation.composer.dock` 面板

改动功能时记得同步改描述，避免「声明与代码不符」被打回。
