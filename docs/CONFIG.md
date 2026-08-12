# 配置说明

配置来源优先级：**环境变量 > `vision-config.json` > 内置默认值**。`setup.mjs` 会帮你生成 `vision-config.json` 与 `.mcp.json`。

## 环境变量一览

### 桥接服务（`zhipu-bridge-api.js`，8765）

| 变量 | 含义 | 默认 |
|---|---|---|
| `VISION_API_KEY` | 视觉模型 API Key | 来自 `vision-config.json` |
| `VISION_BASE_URL` | 上游接口 base url | `https://open.bigmodel.cn/api/paas/v4` |
| `VISION_MODEL` | 模型名 | `glm-4.6v` |
| `VISION_CHAT_PATH` | chat 路径 | `/chat/completions` |
| `VISION_API_KEY_2` / `VISION_BASE_URL_2` / `VISION_MODEL_2` | **备选提供商**（主提供商瞬时失败自动回退） | 空（不启用） |
| `LISTEN_PORT` | 桥接端口 | `8765` |
| `MAX_LONG_SIDE` | 图片压缩长边（像素） | `1920` |
| `CACHE_TTL_MS` | 去重缓存 TTL | `3600000`（1h） |
| `CACHE_MAX` | 缓存条数上限（LRU） | `500` |
| `RATE_LIMIT_PER_MIN` | 按用户每分钟限流 | `0`（不限） |
| `RATE_LIMIT_PER_DAY` | 按用户每天限流 | `0`（不限） |
| `USAGE_LOG` | 用量日志开关 | `1` |
| `LOG_DIR` | 日志目录 | `<项目根>\logs` |

### MCP Server（`mcp-image-analyzer/`）

| 变量 | 含义 | 默认 |
|---|---|---|
| `BRIDGE_BASE_URL` | 桥接地址 | `http://127.0.0.1:8765` |
| `BRIDGE_SCRIPT_PATH` | 桥接脚本路径（相对则相对项目根） | `<项目根>\zhipu-bridge-api.js` |
| `AUTO_SPAWN_BRIDGE` | 桥接未启动时自动拉起 | `1` |
| `MCP_USER` | 用户标识（限流/日志按人隔离） | 系统用户名 |

### 远程 HTTP 入口（`server-http.js`，公司部署）

| 变量 | 含义 | 默认 |
|---|---|---|
| `MCP_HTTP_PORT` | 远程端口 | `8831` |
| `MCP_HTTP_HOST` | 绑定地址 | `127.0.0.1` |
| `MCP_AUTH_TOKEN` | Bearer 鉴权 token（空=不鉴权） | 空 |
| `MCP_SESSION_TTL_MS` | 会话闲置超时 | `900000`（15min） |

## vision-config.json

`setup.mjs` 生成，git 忽略。字段：

```jsonc
{
  "base_url": "https://open.bigmodel.cn/api/paas/v4",
  "api_key": "你的key",          // 留空则分析会失败
  "model": "glm-4.6v",
  "chat_path": "/chat/completions",
  "providers": [                   // 可选的备选提供商（数组第 2 项起自动成为回退链）
    {
      "name": "backup-openai",
      "base_url": "https://api.openai.com/v1",
      "api_key": "sk-xxx",
      "model": "gpt-4o",
      "chat_path": "/chat/completions"
    }
  ]
}
```

> **省钱技巧（智谱免费为主 + 付费兜底）**：免费模型平时不花钱，但高峰常被限流（HTTP 429）。把它设为主提供商、付费版设为备选，免费被限流时自动切付费，既省钱又稳：
> ```jsonc
> {
>   "base_url": "https://open.bigmodel.cn/api/paas/v4",
>   "api_key": "你的key",
>   "model": "glm-4.6v-flash",          // 主=免费 flash（不收费）
>   "chat_path": "/chat/completions",
>   "providers": [
>     { "name": "free-flash", "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "你的key", "model": "glm-4.6v-flash" },
>     { "name": "paid-46v",  "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "你的key", "model": "glm-4.6v" }
>   ]
> }
> ```
> 免费被限流时会自动回退到付费版；`meta.provider` 会标明实际用的是哪个。

## 换提供商（零代码）

本系统只依赖 **OpenAI 兼容的 chat/completions + vision（image_url base64）** 接口。切换提供商只需改配置：

```bash
# 例：切到本地 Ollama（llama3.2-vision 等视觉模型）
VISION_BASE_URL=http://127.0.0.1:11434/v1 VISION_MODEL=llama3.2-vision node zhipu-bridge-api.js

# 例：切到 OpenAI
VISION_BASE_URL=https://api.openai.com/v1 VISION_MODEL=gpt-4o VISION_API_KEY=sk-xxx node zhipu-bridge-api.js
```

## 调试端点

```bash
curl 'http://127.0.0.1:8765/health'                                 # 健康检查
curl 'http://127.0.0.1:8765/analyze?path=E:\temp\shot.png'          # 分析
curl 'http://127.0.0.1:8765/analyze?path=...&task=error&lang=en'    # 报错模板 + 英文
curl 'http://127.0.0.1:8765/analyze?path=...&force_action=stop'     # 确定性"停"（测试钩子）
curl 'http://127.0.0.1:8765/analyze?path=...&raw=1'                 # 原始模型输出
```

## 行为说明

- **缓存**：同一张图（MD5 + task + lang + 模型）1 小时内重复分析直接命中，命中时 `meta.cache="hit"`。
- **限流**：按 `?user=` 标识计数，超限返回 HTTP 429 + `Retry-After`；本地默认不限。
- **用量日志**：每天一个 JSONL 文件，记录 user / md5 / task / provider / token 用量 / action / 延迟。
- **停/续**：响应 `control.action` 由视觉模型自主给出；桥接无状态，停/续由 Claude 侧循环执行。
