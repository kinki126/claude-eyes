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

## 切换视觉提供商

本系统只依赖 **OpenAI 兼容的 chat/completions + vision（image_url base64）** 接口，主流视觉模型都能用。

### 一键切换（推荐）

```bash
node setup.mjs --provider zhipu       # 智谱（GLM，免费 flash 或付费 4.6V）
node setup.mjs --provider qwen        # 通义千问（Qwen-VL）
node setup.mjs --provider doubao      # 豆包（Doubao-Seed-Evolving）
node setup.mjs --provider openai      # OpenAI（GPT-4o）
node setup.mjs --provider siliconflow # 硅基流动（Qwen2.5-VL-72B）
node setup.mjs --provider ollama      # 本地 Ollama（llama3.2-vision 等）
```

切换会**保留 api_key**、备份旧配置（`vision-config.json.bak`）。换提供商后要它的 API Key：`node setup.mjs --reset-key`（或设 `VISION_API_KEY`）。

### 提供方预设对比

| 预设 | 模型 | 适合场景 | 备注 |
|---|---|---|---|
| `zhipu` | `glm-4.6v`(默认,付费) | 中文 UI/报错 OCR | 中文识别强；想省钱可手动改 `glm-4.6v-flash` |
| `qwen` | `qwen-vl-max` | 截图转代码、GUI 理解 | 性价比优，截图→代码准确率高 |
| `doubao` | `doubao-seed-evolving` | 推理 + 多模态、工具调用 | 固定模型 ID 持续进化；key 在火山方舟创建 |
| `openai` | `gpt-4o` | 通用强视觉 | 需海外账号/网络 |
| `siliconflow` | `Qwen/Qwen2.5-VL-72B-Instruct` | 开源模型托管 | 国内可访问 |
| `ollama` | `llama3.2-vision` | 本地/隐私 | 免费但精度一般 |

> 价格请以各平台当前定价为准；免费模型（如 GLM-4.6V-Flash）平时省钱但高峰可能限流（429）。

### 手动改配置（等价）

```bash
# 例：切到本地 Ollama（临时，用环境变量）
VISION_BASE_URL=http://127.0.0.1:11434/v1 VISION_MODEL=llama3.2-vision node zhipu-bridge-api.js

# 或直接改 vision-config.json 的 base_url / model / api_key（改完重启桥接）
```

### 提供商字段：`disable_json_mode`（可选）

主提供商和 `providers[]` 里每一项都支持 `disable_json_mode` 字段，控制是否启用 `response_format: { type: 'json_object' }`：

| 取值 | 行为 | 适用场景 |
|---|---|---|
| 不写 / `false` | 默认启用 JSON 模式 | 智谱 / OpenAI / 通义 / 豆包等主流云厂商（推荐） |
| `true` | 关闭 JSON 模式，靠 bridge 的 5 层 fallback 兜底 | Ollama 等不支持 `response_format` 的本地模型 |

**自动识别**：base_url 含 `127.0.0.1:11434` / `localhost:11434` 或 name 含 `ollama` 时，默认按 `disable_json_mode: true` 处理（无需显式配置）。手动设 `disable_json_mode: false` 可覆盖。

## 调试端点

```bash
# 健康检查
curl 'http://127.0.0.1:8765/health'

# 指标报告（v1.4.0 新增）：QPS / 延迟分位 / 错误率 / 按 task/provider/user 聚合
curl 'http://127.0.0.1:8765/metrics'

# GET 分析（本地文件路径）
curl 'http://127.0.0.1:8765/analyze?path=E:\temp\shot.png'
curl 'http://127.0.0.1:8765/analyze?paths=图1.png&paths=图2.png'              # 多图
curl 'http://127.0.0.1:8765/analyze?paths=a.png&paths=b.png&task=diff'         # 多图差异对比
curl 'http://127.0.0.1:8765/analyze?path=...&task=error&lang=en'              # 报错模板 + 英文
curl 'http://127.0.0.1:8765/analyze?path=...&force_action=stop'               # 确定性"停"（测试钩子）
curl 'http://127.0.0.1:8765/analyze?path=...&raw=1'                            # 原始模型输出
curl 'http://127.0.0.1:8765/analyze?path=...&crop_bbox={"x":0.05,"y":0.02,"w":0.4,"h":0.12}'  # 裁剪放大

# 带 X-Request-Id 头（v1.4.0 新增）：客户端传入则原样回，不传则自动生成
curl -H 'X-Request-Id: my-trace-001' 'http://127.0.0.1:8765/analyze?path=...&force_action=continue'

# POST 分析（远程模式 / 客户端本地无文件时用）
curl -X POST http://127.0.0.1:8765/analyze \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: my-trace-002' \
  -d '{"images":[{"base64":"iVBOR..."}],"task":"error","desc":"看下这个报错"}'
```

## `/metrics` 报告字段（v1.4.0 新增）

| 字段 | 含义 |
|---|---|
| `uptime_ms` | 进程已运行毫秒 |
| `total_requests` | 总请求数（不含 /metrics 自身、不含 400 等前置失败） |
| `total_errors` | 错误请求数（5xx / 上游全部失败） |
| `error_rate` | 错误率（0~1） |
| `cache_hits` / `cache_misses` | 缓存命中 / 未命中计数 |
| `cache_hit_rate` | 缓存命中率（0~1） |
| `latency_p50_ms` / `latency_p95_ms` / `latency_p99_ms` | 延迟分位（10 分钟滚动窗口） |
| `by_task` / `by_provider` / `by_user` | 按 task / provider / user 维度的请求计数 |
| `error_types` | 按错误类型聚合（`all_providers_failed` / `internal`） |
| `window_ms` | 滚动窗口大小（默认 600000 = 10 分钟） |

> 仅内存状态，进程重启清零。配 Prometheus + Grafana 时通过 `/metrics` 抓 JSON 转 prom-format 即可。

## `X-Request-Id` 贯穿（v1.4.0 新增）

- 客户端可在请求头传 `X-Request-Id: <trace-id>`；bridge **原样回传**响应头
- 不传则自动生成 `r-<ts>-<rand>`
- MCP 工具（[analyze-tool.js](file:///e:/temp/mcp-image-analyzer/analyze-tool.js)）自动生成 `mcp-<uuid>` 传给 bridge
- 响应 `meta.request_id` 字段同步透传
- usageLog / historyLog 都记录 `request_id`，便于跨日志排查"哪一环慢"

## 行为说明

- **缓存**：同一张图（MD5 + task + lang + 模型）1 小时内重复分析直接命中，命中时 `meta.cache="hit"`。
- **图片字节缓存**：同一张图换不同 `desc`/`focus`/`crop_bbox` 时，sharp 压缩结果直接命中字节缓存跳过，TTL 是分析缓存的 2 倍。`meta.cache` 仍按"最终分析结果是否命中"标记，字节缓存命中不影响 `meta.cache` 值。
- **限流**：按 `?user=` 标识计数，超限返回 HTTP 429 + `Retry-After`；本地默认不限。
- **用量日志**：每天一个 JSONL 文件，记录 user / md5 / task / provider / token 用量 / action / 延迟 / request_id。
- **分析历史**（v1.4.0 新增）：每次成功的分析（非 `force_action`）追加一行到 `<项目根>\.claude-eyes\history.jsonl`，含 ts / request_id / user / md5 / task / action / analysis（截断 2000 字）/ keywords / regions（前 5 个）/ cache / latency_ms。便于回看与重跑。
- **停/续**：响应 `control.action` 由视觉模型自主给出；桥接无状态，停/续由 Claude 侧循环执行。
- **重试 + 熔断**：429/5xx/超时/连接重置等瞬时错误，同一 provider 内先重试 2 次（500ms → 1s 指数退避），仍失败再切下一个 provider；连续失败 3 次的 provider 被熔断 5 分钟，期间直接跳过，5 分钟后放一次试探。错误信息会出现在抛出的 `Error.message` 里（`所有视觉提供商均调用失败: <name>: <原因> | <name>: <原因>`）。
- **JSON 模式**：默认启用 `response_format: json_object`，模型直接吐合法 JSON；不支持的 provider 可配 `disable_json_mode: true` 关闭，bridge 仍靠 5 层 fallback 兜底解析。
- **task 自动路由**（v1.4.0 新增）：用户没显式传 `task`（或传 `general`）时，bridge 扫描 `desc` + `focus` 关键词自动切到对应专项 task（报错→`error`、对比→`diff`、文字→`ocr`、界面→`ui`）。用户显式传 task 时永远以用户指定为准。
- **图像格式自适应**（v1.4.0 新增）：bridge 按图本身 metadata 选输出格式——照片类（jpeg/webp 来源且无 alpha 通道）转 WebP q=80，体积降 80%+；UI/文字截图保持 PNG 无损，文字清晰。
- **超长图切片**（v1.4.0 新增）：单图长宽比 > 3 时按长边切成 2-5 段，每段间 10% 重叠避免关键信息被切到中间；每段独立压缩保持清晰度。响应 `meta.slices` 透传实际切片数。仅单图启用（多图场景保持原样避免顺序混乱）。
- **OCR 二值化预处理**（v1.4.0 新增）：`task=ocr` 时对图做灰度 + 直方图均衡 + 阈值二值化再传给模型，彩色背景上的文字、小字、密集文字识别率立升。其他 task 保留原色（UI 需要看颜色判断按钮状态/品牌色）。
