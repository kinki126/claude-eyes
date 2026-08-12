# 👁️ Claude Eyes(克劳德之眼)

> 让 **Claude Code** 拥有"眼睛"——通过 MCP 工具 + 视觉模型桥接分析本地截图,并**自动决定**分析流程是继续还是停止。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D%2018-brightgreen.svg)](package.json)
[![CI](https://github.com/kinki126/claude-eyes/actions/workflows/ci.yml/badge.svg)](https://github.com/kinki126/claude-eyes/actions/workflows/ci.yml)

<!-- 若你的 GitHub 用户名不是 kinki126，请把上面 badge 链接里的 kinki126/claude-eyes 改成你的用户名/仓库名 -->

[English](README.md) · **中文**

---

当你的 Claude Code 跑在无视觉后端(如 DeepSeek)上时,它看不了图。**Claude Eyes** 解决这个问题:你粘贴截图、截屏、或给个路径,Claude 调用 `analyze_image` MCP 工具,视觉模型分析后返回结构化结果,并**自动决定**本次流程是继续(等下一张)还是停止。

## 特性

- 🖼️ **函数调用分析图片**:Claude 原生调用 `analyze_image` 工具,无需换模型
- 🔁 **自动停/续控制**:视觉模型根据图片内容自主决定 `continue`(继续等下一张)或 `stop`(流程结束)
- 📋 **三种喂图方式**:VS Code 面板粘贴(Trae 式)/ 截图自动保存 / 直接给路径
- 🔌 **可换提供商**:只依赖 OpenAI 兼容的 chat/completions + vision(image_url base64),改配置即可切换智谱/OpenAI/通义千问-VL/DeepSeek-VL/Ollama/vLLM
- ⚙️ **运维就绪**:图片去重缓存、按用户限流、用量日志、健康检查、多模型自动回退、桥接进程自动拉起
- 🧩 **可迁移**:全部路径由当前目录 + 用户主目录自动推导,一键 `setup.mjs` 配置,整体搬迁即用

## 架构

```
Claude Code ──函数调用──▶ mcp-image-analyzer (MCP) ──HTTP──▶ 桥接 (8765) ──▶ 视觉LLM
                              ▲                                   │
                       按需自动拉起                         统一响应 { analysis, control }
```

- `zhipu-bridge-api.js` + `vision-client.js`:桥接服务与视觉提供商抽象
- `mcp-image-analyzer/`:MCP Server(`index.js` 本地 stdio,`server-http.js` 远程 HTTP)
- `setup.mjs`:一键安装/配置向导

## 快速开始

前置:Node ≥ 18、Claude Code。

```bash
# 1. 运行一键安装向导(填你自己的视觉模型 API Key)
node setup.mjs

# 2. 重启 Claude Code(在项目根),/mcp 确认 image-analyzer ✓

# 3. 开始使用
```

完整上手见 [`QUICKSTART.md`](QUICKSTART.md)。

## 使用方式

| 方式 | 操作 |
|---|---|
| 🖼️ **面板粘贴**(Trae 式) | VS Code 插件面板 `Ctrl+V` 图片 → 回车,自动分析 |
| 📸 **截图自动保存** | `Win+Shift+S`(开自动保存)→ 说"分析最新一张截图" |
| 📁 **直接给路径** | 说"分析 <图片绝对路径>" |

详细场景见 [`docs/USAGE.md`](docs/USAGE.md)。

## 配置

优先级:环境变量 > `vision-config.json` > 默认值。换模型、多模型回退、缓存/限流/日志等详见 [`docs/CONFIG.md`](docs/CONFIG.md)。

## 文档

- [`QUICKSTART.md`](QUICKSTART.md) — 新用户/同事 5 分钟接入
- [`docs/CONFIG.md`](docs/CONFIG.md) — 完整配置说明
- [`docs/USAGE.md`](docs/USAGE.md) — 各种场景使用说明
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — 公司内网部署(远程 MCP / 本地分发包)

## 目录结构

```
├── setup.mjs                     # 一键安装/配置向导
├── zhipu-bridge-api.js           # 桥接服务(8765)
├── vision-client.js              # 视觉提供商抽象 + 多模型回退
├── vision-config.example.json    # 配置模板(空 key)
├── latest-shot.mjs               # 找最新截图
├── extract-pasted-image.mjs      # 提取面板粘贴的图片(转录 base64 落盘)
├── save-shot.bat                 # 剪贴板截图存盘(备用)
├── start-bridge.bat / start-remote-mcp.bat
├── mcp-image-analyzer/           # MCP Server
│   ├── index.js                  # 本地 stdio 入口
│   ├── server-http.js            # 远程 HTTP 入口(公司部署)
│   ├── analyze-tool.js           # 共享工具逻辑(含自动拉起)
│   └── smoke/                    # 手工冒烟脚本
├── test/                         # 自动化测试(npm test)
└── .claude/skills/analyze-image/ # Claude 侧 skill(自动触发 + 路径解析)
```

## 开发与测试

```bash
npm test             # 离线测试:解析器单测 + 桥接 force_action 冒烟(不需要真实 API Key)
npm run smoke        # 本地 MCP 冒烟(需要桥接运行 + 真实 Key)
npm run smoke:remote # 远程 HTTP MCP 冒烟
```

## 许可证

[MIT](LICENSE)

## 注意事项

- **密钥**:每个使用者注册自己的视觉模型账号,`vision-config.json` 存放自己的 key(已被 `.gitignore` 忽略,严禁提交)。
- **成本**:每次分析是付费 API 调用。
- **隐私**:截图会发送到所配置的视觉模型云端(如智谱),涉及敏感数据时请评估;也可配置本地模型(Ollama)。
