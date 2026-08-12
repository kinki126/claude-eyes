# 贡献指南

感谢你愿意参与改进！先看一下这些约定。

## 环境准备

- Node ≥ 18
- 先跑 `node setup.mjs` 完成本地配置（含你自己的视觉模型 API Key）

## 开发 / 测试

```bash
npm test          # 离线测试：解析器单测 + 桥接 force_action 冒烟（不需要真实 API Key）
npm run smoke     # 本地 MCP 冒烟（需要桥接运行 + 真实 Key）
```

提交前请确保 `npm test` 全绿。

## 提 Issue

- 用对应的模板（Bug / Feature）。
- 描述里尽量带上：版本、Node 版本、操作系统、`/mcp` 输出、相关日志（`logs/` 下的 JSONL）。

## 提 PR

- 分支命名：`fix/xxx`、`feat/xxx`、`docs/xxx`。
- 改动尽量小、聚焦单一目的。
- 新增功能请同步更新 `docs/` 与 `CHANGELOG.md`。
- 不要提交 `vision-config.json`、`.mcp.json`、`shots/`、`logs/`（已 gitignore）。

## 目录速览

```
setup.mjs                安装向导
zhipu-bridge-api.js      桥接服务
vision-client.js         视觉提供商抽象 + 多模型回退
mcp-image-analyzer/      MCP Server（index.js 本地 / server-http.js 远程）
latest-shot.mjs / extract-pasted-image.mjs / save-shot.bat   截图辅助
.claude/skills/analyze-image/   Claude 侧 skill
test/                    自动化测试（npm test 运行）
```
