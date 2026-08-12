# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-12

初始公开发布。

### 新增

- **桥接服务** `zhipu-bridge-api.js`(端口 8765):统一响应 `{analysis, control}`,模型自动决定 `continue/stop`
- **视觉提供商抽象** `vision-client.js`:只依赖 OpenAI 兼容 vision 接口,改配置零代码切换模型;主/备多提供商自动回退
- **MCP Server** `mcp-image-analyzer/`:本地 stdio(`index.js`)+ 远程 HTTP(`server-http.js`)双入口;桥接进程按需自动拉起
- **三种喂图方式**:VS Code 面板粘贴(自动从会话转录提取 base64)/ 截图自动保存 / 直接给路径
- **Claude 侧 skill** `analyze-image`:自动触发(粘贴即分析)+ 优先级路径解析
- **运维能力**:图片 MD5 去重缓存、按用户限流、JSONL 用量日志、`/health`、`?force_action` 确定性测试钩子
- **一键安装向导** `setup.mjs`:检查环境、配置密钥、装依赖、生成 `.mcp.json`、自检
- **自动化测试** + **GitHub Actions CI**(Node 18/20/22 矩阵,离线运行)

### 文档

- README(英文 + 中文)、QUICKSTART、docs/(CONFIG / USAGE / DEPLOY)
- CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、Issue/PR 模板
