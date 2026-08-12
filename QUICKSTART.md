# 快速上手（新用户 / 同事 5 分钟接入）

本系统让你在 Claude Code 里**粘贴截图就能分析**（报错、界面、文字），即使你的 Claude 后端不支持看图。

## 前置条件

1. **Node ≥ 18**：终端输入 `node -v` 确认（没有则去 nodejs.org 安装 LTS）。
2. **Claude Code**：CLI 或 VS Code 插件（Anthropic Claude Code 扩展）。
3. **视觉模型账号**：注册 [智谱开放平台](https://open.bigmodel.cn)（或你公司指定的其他视觉模型），开通后在控制台拿到 **API Key**。

## 安装（一条命令）

在项目根目录打开终端，运行：

```bash
node setup.mjs
```

向导会：
- 检查 Node 版本
- 让你输入**你自己的 API Key**（或先设环境变量 `VISION_API_KEY`）
- 自动安装依赖（两处）
- 生成 `.mcp.json` 注册 MCP 工具
- 自检桥接服务

> 换 key：重新运行 `node setup.mjs --reset-key`。

## 开始使用

**重启 Claude Code**（在项目根启动，让 MCP 生效）→ 输入 `/mcp` 应看到 `image-analyzer ✓`。

然后任选一种方式：

| 方式 | 操作 |
|---|---|
| 🖼️ **粘贴图片** | VS Code 插件面板 `Ctrl+V` 粘贴截图 → **回车**，自动分析（无需打字） |
| 📸 **截图分析** | `Win+Shift+S` 截图（截图工具开"自动保存"）→ 说"**分析最新一张截图**" |
| 📁 **给路径** | 说"**分析 E:\xxx\shot.png**" |

## 常见问题

**Q: /mcp 里没有 image-analyzer?**
没重启 Claude、或 `.mcp.json` 未生成。运行 `node setup.mjs` 后重启。

**Q: 分析时报"桥接未启动"?**
先等待自动拉起(约 3~8 秒);仍失败就手动 `node zhipu-bridge-api.js`。

**Q: 粘贴图片后没反应?**
确认是 VS Code 插件**面板**里粘贴,且粘贴后按了**回车**(插件没有"粘贴即发送"的钩子)。

**Q: 提示 api_key 为空?**
`node setup.mjs --reset-key` 重新填 key。

更多场景与排查见 [`docs/USAGE.md`](docs/USAGE.md)。
