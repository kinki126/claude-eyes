# 安全说明

## API Key 处理（重要）

- 本项目使用你自己的**视觉模型 API Key**（如智谱），存放在 `vision-config.json`。
- `vision-config.json` 已被 `.gitignore` 忽略，**严禁提交**。仓库里只含空 key 模板 `vision-config.example.json`。
- 分发项目给他人时，先删除 `vision-config.json`，避免共享/泄露你的 key。
- 换 key：运行 `node setup.mjs --reset-key`。

## 数据与隐私

- 分析时，图片会被发送到你配置的视觉模型云端（如智谱）。**不要分析含敏感信息的截图**，除非你已评估该提供商的数据处理政策。
- 涉敏场景建议将提供商切换为本地模型（如 Ollama），见 `docs/CONFIG.md`。

## 网络

- 本地桥接默认只监听 `127.0.0.1:8765`。
- 公司远程部署（`server-http.js`）请务必设置 `MCP_AUTH_TOKEN`，并只暴露于内网。

## 报告漏洞

发现安全问题，请**不要**公开提交 Issue。直接通过仓库主页的"Security"或维护者邮箱私密反馈，我们会尽快处理。
