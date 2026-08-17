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

- 🖼️ **函数调用分析图片**：Claude 原生调用 `analyze_image` 工具，无需换模型
- 🔁 **自动停/续控制**：视觉模型根据图片内容自主决定 `continue`（继续等下一张）或 `stop`（流程结束）
- 📋 **四种喂图方式**：VS Code 面板粘贴（Trae 式）/ 截图自动保存 / 直接给路径 / **base64 上传（远程 MCP）**
- 🔌 **可换提供商**：只依赖 OpenAI 兼容的 chat/completions + vision（image_url base64），改配置即可切换智谱/OpenAI/通义千问-VL/DeepSeek-VL/Ollama/vLLM
- ⚙️ **运维就绪**：图片去重缓存 + 字节缓存、按用户限流、用量日志、健康检查、多提供商回退 + **重试与熔断**、桥接进程自动拉起
- 📊 **可观测性**（v1.4.0）：`/metrics` 端点导出 QPS / 延迟 p50/p95/p99 / 错误率 / 按 task/provider/user 聚合（10 分钟滚动窗口）；`X-Request-Id` 贯穿 MCP → bridge → LLM 日志
- 🧠 **task 自动路由**（v1.4.0）：bridge 扫描 `desc`/`focus` 关键词自动把 `general` 切到 `error`/`diff`/`ocr`/`ui`（用户显式传 task 时永远优先）
- 🗂️ **分析历史**（v1.4.0）：每次成功分析自动追加到 `.claude-eyes/history.jsonl`，grep 即可回看"昨天那张 TypeError 的图"
- 🧩 **可迁移**：全部路径由当前目录 + 用户主目录自动推导，一键 `setup.mjs` 配置，整体搬迁即用
- 🔍 **多轮追问 + 坐标定位 + 精准放大**：`focus` 让视觉模型定向细看；`regions` 输出归一化 bbox；**`crop_bbox` 按上一轮 bbox 裁剪原图并放大到最小边 800px**（v1.3.0+），多轮追问精度大增
- 🖼️ **图像处理自适应**（v1.4.0）：照片 → WebP q=80（体积降 80%+）；UI/文字 → PNG 无损；长截图（长宽比 > 3）自动切片 2-5 段；`task=ocr` 自动二值化预处理，文字识别更准
- 🧾 **原文兜底 + 反向验证**：`verbatim` 逐字转录报错堆栈/错误码，不被概括吞掉；`task=verify` 把推理结论发回视觉模型核验（verdict: true/false/uncertain）
- 🧾 **diff 结构化输出**（v1.6.0）：`task=diff` 返回 `diffs[]` 数组，逐项列出差异（item/from/to/change_type/bbox），Claude 可直接用 markdown 表格呈现，不再是一坨散文
- ✅ **断言式 verify**（v1.6.0）：`task=verify` 支持 `description: "assert=按钮是否为红色"`，返回结构化 `verify: { passed: true|false|null, reason }`（与 verdict 对齐；uncertain 时 passed=null），便于截图回归测试直接判过没过
- 🗂️ **历史搜索**（v1.6.0）：`GET /history?task=&keyword=&since=&until=&limit=` 端点 + `search_history` MCP 工具，按 task/关键词/时间范围搜索落盘的 `history.jsonl`，替代手动 grep
- 🔄 **多轮追问上下文继承**（v1.5.0）：bridge 按图片 md5 缓存上一轮分析上下文，同图追问（带 focus/crop_bbox）自动注入前一轮的 task/keywords/regions/analysis 摘要，用户不用重复"就是刚才那张图的 xxx 位置"
- 📢 **阶段进度通知**（v1.5.0）：`analyze_image` / `locate_code` / `search_history` 在关键阶段推送 `notifications/message`（准备 → 桥接就绪 → 调用模型 → 完成），降低 MCP 客户端的感知延迟
- 🔍 **代码定位**（v1.5.0）：`locate_code` MCP 工具在项目代码里搜关键词（ripgrep / findstr / grep 回退），返回 `{ file, line, match }` 候选，让 Claude 从截图报错直接跳到源码行
- 📦 **默认 JSON 模式**（v1.3.0+）：默认启用 `response_format: json_object`，模型直接吐合法 JSON；Ollama 等不支持的 provider 自动关闭，bridge 仍靠 5 层 fallback 兜底
- 🔐 **远程就绪**：`POST /analyze` 收 base64 图片（body 上限 64MB）；`server-http.js` 鉴权用 `crypto.timingSafeEqual` 防时序攻击

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
node setup.mjs   # 默认用户级安装:任意项目可用;只想本项目用则加 --project-level
# 推荐:装到固定目录(解压文件夹可删) -> node setup.mjs --install
# 换视觉模型: node setup.mjs --provider qwen|zhipu|doubao|openai|ollama

# 2. 重启 Claude Code(在项目根),/mcp 确认 image-analyzer ✓

# 3. 开始使用
```

完整上手见 [`QUICKSTART.md`](QUICKSTART.md)。

**升级**：新用户/固定安装 `node setup.mjs --install`（或 `--update`）；老 v1.00 就地用户下载新版解压后跑 `node setup.mjs --upgrade`（自动卸旧装新）。详见 [`QUICKSTART.md`](QUICKSTART.md)「升级」。

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
