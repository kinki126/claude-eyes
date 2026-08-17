# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.6.0] - 2026-08-17

### 新增

- **P1-3 `task=diff` 结构化 `diffs[]` 数组**：多图对比时除了常规 `text` 外，模型再返回一个 `diffs` 数组，逐项列出各图差异
  - 字段：`item`（差异项名）/ `from`（图1内容）/ `to`（图2内容）/ `change_type`（`add`/`remove`/`modify`，模型乱填时归一化为 `modify`）/ `image_index`（差异所在图序号）/ `bbox`（差异区域归一化坐标，复用 `parseRegions` 尺度自适应逻辑，0~1000 / 0~100 / 0~1 三档自动归一）
  - `parseDiffs(raw)` 函数：最多返回 20 条，过滤掉空对象
  - `buildPrompt` 为 `task=diff` 加专属输出格式指令，要求模型直接输出 JSON 数组
  - `extractAnalysis` 解析 `diffs` 字段并加入响应；超过 3 个差异时 SKILL.md 引导 Claude 用 markdown 表格呈现
- **P1-5 `task=verify` 显式断言 + `verify.passed`**：支持 `description: "assert=按钮是否为红色"` 语法，bridge 从中提取断言内容；返回结构化 `verify: { passed: true|false|null, reason }`
  - `parseVerifyObject(raw, verdict)` 函数：与 `verdict` 字段语义对齐——`verdict=uncertain` 时强制 `passed=null`（即使模型输出 `passed=true` 也覆盖），避免「看不清但判过」的矛盾
  - `passed` 接受 `true/false/null` + 字符串形式 `"true"/"false"/"null"/"uncertain"`，非布尔值时从 `verdict` 推导
  - 向后兼容：模型未输出 `verify` 对象时，从 `verdict` 推导（`true→passed=true`、`false→passed=false`、其他→null）
  - `buildPrompt` 为 `task=verify` 加专属指令要求输出 `verify` 对象
  - SKILL.md 第 3.5 节更新：推荐用 `assert=` 语法、`verify.passed` 字段，便于截图回归测试直接判过没过
- **P2-4 `/history` 端点 + `search_history` MCP 工具**：把每次成功分析落盘的 `history.jsonl` 暴露成可查询接口
  - bridge 新增 `GET /history?task=&keyword=&since=&until=&limit=&user=` 端点，返回 `{ ok, total, returned, query, results }`
  - `historySearch({ task, keyword, since, until, limit, user })` 函数：keyword 在 `analysis` 文本 + `keywords` 数组里模糊匹配（大小写不敏感），结果按 `ts` 倒序，limit 默认 20 上限 100
  - MCP 新增 `search_history` 工具，注册到 `index.js`（stdio）和 `server-http.js`（HTTP）两个入口
  - 进度通知 2 阶段：正在搜索 → 搜索完成
  - SKILL.md 第 1.3 节更新：推荐用 `search_history` 工具替代手动 grep 历史

### 修复

- **`ensureBridge` 不接受自定义 baseUrl**：`createSearchHistoryHandler({ bridgeBaseUrl })` 和 `createAnalyzeImageHandler({ bridgeBaseUrl })` 接受的自定义 URL 没传给 `ensureBridge`，导致测试在自定义端口启动 bridge 后 handler 仍去探测默认 8765 → 拉起失败 → `isError=true`
  - `isBridgeUp(baseUrl, timeoutMs)` 和 `ensureBridge(baseUrl)` 加默认参数，两个 handler 都把 `bridgeBaseUrl` 透传进去
- **`/history` 端点用 legacy `urlObj.query`**：`new URL()` 没有 `.query` 属性（只有 `url.parse()` 才有），导致访问 `q.task` 时抛 `Cannot read properties of undefined` → 500
  - 改用 `urlObj.searchParams.get(...)` 与 `/analyze` 端点保持一致

### 测试

- 新增 `parseDiffs` 单测：完整解析 / 非法项过滤 / change_type 归一化 / bbox 尺度自适应（0~1 / 0~100 / 0~1000 三档）/ 条目上限 20
- 新增 `parseVerifyObject` 单测：完整对象 / verdict 推导 / 字符串 passed 转 boolean / uncertain 强制 null / 缺对象向后兼容
- 新增 `historySearch` 单测：无文件 / task 过滤 / keyword 模糊匹配 / 时间范围 / limit 上限
- 新增 `search_history` 工具端到端测试：spawn bridge 子进程 → 调 /history → 验证 ok/total/returned/results 结构 + 进度通知；task 过滤参数回显
- 总测试数 239 → 260，全部通过

## [1.5.0] - 2026-08-17

### 新增

- **P0-1 多轮追问上下文自动继承**：bridge 端按图片 md5 维护「最近分析上下文」缓存（`imgContextCache`），同一张图第二轮带 `focus` / `crop_bbox` 追问时，自动把上一轮的 `{ task, keywords, regions, analysis 摘要 }` 注入到 prompt 的 `description` 里
  - 触发条件：单图 + 有 focus 或 crop_bbox + 非 force_action + 距上次 < 1h
  - 响应 meta 新增 `context_inherited: boolean`，标记本轮是否注入了上一轮上下文
  - `buildInheritedContext(prevCtx)` 构造注入片段：keywords 取前 5 个、regions 取前 3 个、analysis 截断到 200 字符
  - 用户不再需要在 `focus` 里重复交代「就是刚才那张图的 xxx 位置」——bridge 已自动告诉模型
- **P0-2 阶段进度反馈（MCP notification）**：`analyze_image` 和 `locate_code` 工具 handler 接收 `extra` 参数，通过 `sendNotification` 向客户端推送 `notifications/message`（LoggingMessageNotification）
  - `analyze_image` 在 4 个阶段发通知：准备分析 → 桥接就绪 → 调用视觉模型 → 分析完成/失败
  - `locate_code` 在 2 个阶段发通知：正在搜索 → 搜索完成
  - `makeProgressSender(extra)` 工具函数，notification 失败静默忽略，不阻塞主流程
  - 兼容旧调用方式（不传 extra 也不崩溃）
- **P1-1 `locate_code` MCP 新工具**：在项目代码里搜索关键词，返回结构化 `{ file, line, match }` 候选列表
  - `createLocateCodeHandler()` 实现，搜索后端优先 ripgrep，回退 findstr（Windows）/ grep（其他）
  - 参数：`keywords`（1~10 个）、`project_root`、`max_hits_per_keyword`（默认 5，上限 20）、`file_extensions`
  - 注册到 `index.js`（stdio）和 `server-http.js`（HTTP）两个入口
  - SKILL.md 第 3 节更新指引：优先用 `locate_code` 工具而非直接 grep；拿到候选后用 `Read` 工具读上下文判断；候选多时用 `task=verify` 二次确认

### 测试

- 新增 `imgContextCache` + `buildInheritedContext` 单测 7 项（基本读写 / LRU 淘汰 / 完整上下文构造 / 空 ctx / 缺 keywords/regions）
- 新增 `mcp-tool.test.mjs`（10 项）：P0-2 进度通知（extra/sendNotification / 缺参数不发通知 / 无 extra 兼容）、P1-1 locate_code（缺参数 / 超限 / 搜索命中 / 搜索不命中 / 多关键词 / 自定义扩展名 / 进度通知）
- 新增整合测试 1 项：P0-1 force_action 路径下 `context_inherited=false`（不写入 imgContextCache）
- SKILL.md 新增 P0-1 上下文继承说明 + P1-1 locate_code 工具指引
- 总测试数 222 → 239，全部通过

## [1.4.2] - 2026-08-17

### 新增

- **P0-3 错误响应 `hint` 字段**：所有错误响应（4xx/5xx）补 `hint` 字段，根据 `errorType` 给出 Claude 直接念给用户的「可点击执行」下一步建议：
  - `missing_path` / `file_not_found` / `too_many_images` / `payload_too_large` / `bad_json` / `images_empty` / `base64_invalid` / `rate_limited` / `bad_request` / `all_providers_failed` / `internal` / `unknown_endpoint`
  - `buildHint(errorType, ctx)` 函数实现；ctx 透传 retryAfter / missing 路径 / images[index] 等上下文，让建议更精准
  - 用户不再需要看错误码或翻文档，hint 直接告诉他「① 用「分析 E:\\路径\\截图.png」直接给路径；② 或先 Win+Shift+S 截图再说「分析最新一张截图」；③ 远程模式用 POST /analyze 传 images base64」
- **P1-4 自动裁边 `autoCropBorder`**：单图（无 cropBbox、未切片）场景，bridge 自动用 `sharp.trim({ threshold: 12 })` 裁掉四周纯色边框（含任务栏/侧边栏/白边）
  - 启发式：trim 后任一维度 < 原维度 30%（如全色图被裁到 1x1）→ 回退原 buffer，避免误伤
  - 响应 meta 新增 `auto_cropped: boolean` 和 `auto_crop: { from: {w,h}, to: {w,h} }` 字段，让用户知道是否被裁过
  - 用「维度百分比」而非「面积百分比」判断回退，避免「80x80 内容 + 20px 边框」这种正常裁剪被误判（面积比 0.44 看似过度裁剪实则正常）
- **P2-3 `cost_info` 字段**：响应 meta 新增 `cost_info`，包含 `input_tokens / output_tokens / total_tokens / estimated_cost_usd / cache_saved_tokens / cache_saved_usd / price_per_1k_tokens`
  - `PRICE_PER_1K_TOKENS` 常量（默认 $0.001，可用 env 覆盖）按 1k tokens 估算成本
  - cache 改为存 `{ analysisRes, usage }` 对象，cache hit 时取出上次 usage，使 `cache_saved_tokens` 准确反映上次花费的 tokens
  - 历史日志（`.claude-eyes/history.jsonl`）和 usage 日志同步记录 `cost_info` 与 `auto_cropped`

### 修复

- **`routeTaskByContext` 否定词误匹配**：`没有报错` / `no error` / `without diff` 等否定语境不再误切到对应 task
  - 新增 `NEGATION_WORDS` 列表 + `hasNegationBefore(text, idx)` 函数
  - 遍历所有关键词匹配位置，跳过紧邻否定词的匹配（如「没有报错」不切 error，「没对比过」不切 diff）
  - 测试覆盖：3 项否定语境测试 + 肯定/否定混合测试

### 测试

- 新增 `autoCropBorder` 单测 5 项（带边框/无边框/小边框/无效输入/边界尺寸判断）
- 新增 `buildHint` 单测 5 项（各 errorType 非空 / ctx 透传 / 未知 errorType 兜底）
- 新增整合测试 9 项：
  - P0-3 错误响应 hint 字段（缺 path / 不存在文件 / 404 / 非法 JSON）
  - P2-3 成功响应 cost_info 字段（force_action 路径下全 0）
  - P1-4 auto_cropped 字段（普通图 bool / 带边框图触发 true）
- 整合/usage 测试版本号断言改为动态读 package.json（避免版本升级时回来改测试）
- 总测试数 203 → 222，全部通过

## [1.4.1] - 2026-08-17

### 修复

- **测试驱动修复（v1.4.0 发布后补测发现）**：整合性 / 完整性 / 压力 / 用户使用层面 4 套新测试套件跑完后发现并修复的问题：
  - `integration.test.mjs`：`raw=1` 路径 `forced` 字段断言、`crop_bbox` 透传 `cropped` 字段断言、cache hit 语义（force_action 不进缓存）
  - `completeness.test.mjs`：README 关键词中英文对齐、`/health.cache.max` 常量名（CACHE_MAX_SIZE → CACHE_MAX）、MCP 工具参数列表排除 bridge 侧 URL 参数
  - `stress.test.mjs`：混合请求 `total_requests` 期望值从 90 修正为 60（/metrics /health 不计入请求计数）
  - `usage.test.mjs`：POST body 字段名（description → desc）、GET 参数中文未编码、`latest-shot.mjs` 受其他测试残留文件干扰（改用隔离目录）
- **`isCircuitOpen` 熔断状态误删 bug 确认修复**：v1.4.0 已修，v1.4.1 通过 `vision-client.test.mjs` 正式覆盖，确保连续 3 次失败一定触发熔断

### 新增

- **新增 4 套测试套件共 72 个用例**（总测试数 131 → 203）：
  - `integration.test.mjs`（14 项）：端到端整合性
  - `completeness.test.mjs`（17 项）：版本号 / 文档 / schema 一致性
  - `stress.test.mjs`（13 项）：高负载稳定性与性能
  - `usage.test.mjs`（28 项）：用户使用层面端到端（喂图 / 任务场景 / 历史 / 可观测性 / 错误体验 / 图像处理）

### 文档

- README.md v1.4.0 能力条目补充 `(v1.4.0)` 标记
- docs/CONFIG.md 行为说明补充函数名括号（routeTaskByContext / historyLog 等）
- .gitignore 新增 `test_output.txt` 和 `.claude-eyes/` 规则

## [1.4.0] - 2026-08-17

### 新增

- **可观测性 /metrics 端点**：bridge 暴露 `/metrics`，返回 JSON 报告（uptime / total_requests / total_errors / error_rate / cache_hit_rate / latency_p50/p95/p99_ms / by_task / by_provider / by_user / error_types），10 分钟滚动窗口。配 Prometheus + Grafana 直接看 QPS / P95 / 错误率。
- **`X-Request-Id` 贯穿**：每个 bridge 响应带 `X-Request-Id` 头（客户端传入则原样回，否则自动生成 `r-<ts>-<rand>`）；响应 `meta.request_id` 同步透传；usageLog / historyLog 都记录 request_id，便于跨日志排查"哪一环慢"。MCP 工具自动生成 `mcp-<uuid>` 传给 bridge。
- **task 自动路由**：bridge 扫描 `desc` + `focus` 关键词，自动把 `general` 切到对应专项 task——用户没显式传 task 时尤其实用（`routeTaskByContext` 函数实现）：
  - 报错 / 错误 / exception / stack trace / 崩溃 / traceback / 错误码 / panic / fatal → `error`
  - 对比 / diff / 之前 / 之后 / 差异 / 比较 / before / after / 变化 → `diff`
  - 文字 / 提取文字 / ocr / 转录 / 识别文字 / 内容是什么 → `ocr`
  - 界面 / 布局 / 按钮 / 走查 / 元素 / 组件 / 样式 → `ui`
  - 用户显式传 task 时永远以用户指定为准。
- **分析历史持久化**（`historyLog` 函数）：每次成功的分析（非 force_action）自动落盘到 `<项目根>/.claude-eyes/history.jsonl`，每行一条 JSON（含 ts / request_id / user / md5 / task / action / analysis / keywords / regions / cache / latency_ms）。用户说"昨天那张 TypeError 的图重新看一下"→ Claude 可以 grep history 找 md5 重新分析（1 小时内 cache hit 秒回）。
- **图像格式自适应**：bridge 按 source media type 自动选输出格式——照片类（jpeg/webp 来源且无 alpha）转 WebP q=80，体积降 80%+，传输/成本受益；UI/文字截图保持 PNG 无损，文字清晰。`chooseFormat()` 启发式判断。
- **超长图切片**：长宽比 > 3 的图按高度（竖长）或宽度（横长）切成 2-5 段，每段间 10% 重叠避免关键信息被切到中间；每段独立压缩保持清晰度。`sliceLongImage()` 仅对单图启用（多图场景保持原样避免顺序混乱）。响应 `meta.slices` 字段透传实际切片数。整页网页截图 / 长报错堆栈 / 聊天记录截图文字识别率大增。
- **OCR 二值化预处理**：`task=ocr` 时对图做灰度 + 直方图均衡 + 阈值二值化再传给模型，彩色背景上的文字、小字、密集文字识别率立升。`ocrPreprocess()` 仅对 ocr task 启用，其他 task 保留原色（UI 需要看颜色判断按钮状态/品牌色）。

### 修复

- **`isCircuitOpen` 状态误删 bug**：改前 `openUntil=0`（未熔断状态）时 `Date.now() > 0` 会触发"窗口到期"分支 delete 状态，导致 `markFailure` 累积的失败计数被悄悄清零，**熔断永远触发不了**。改后 `if (s.openUntil === 0) return false;` 未熔断状态保留 failures 计数。测试驱动发现。
- **`parseCropBbox` 边界 case 加固**：v1.3.0 引入时仅覆盖正态输入，v1.4.0 补充越界修正 / 0 宽高 / 非法类型 / null 的兜底分支单测，让异常输入稳定返回 null 而非 crash。
- **`/health` 字段补齐**：补 `cache.max` / `rate_limit` / `providers` 三个字段，让运维查 config 不必看源码。
- **`metrics.byTask` 初始化所有 task 类型**：6 个 task（general/error/diff/ocr/ui/verify）初始值都为 0，避免 `by_task.error` 在没请求时 `undefined`。
- **`METRICS_WINDOW_MS` 字面量化**：从 `10 * 60 * 1000` 改为 `600000`，便于测试断言常量与响应一致。
- **早期 4xx 错误计入 metrics**：缺 path / 文件不存在 / images 为空 / 限流等早期 `return` 路径补调 `metricsObserve({ ok: false })`，让 `total_errors` 真实反映用户错误请求量（之前这些错误不计入，`error_rate` 失真）。
- **`raw=1` 路径返回 meta 字段**：之前只返回 `{note, ...}`，补 `meta: { raw, forced, request_id, bridge_version }`，便于调用方判断是否是 force_action 触发的 raw 响应。

### 测试

- 新增 `vision-client.test.mjs`（20 项）：熔断状态机流转、provider failover 链路、重试 2 次后成功、连续 3 次失败触发熔断、熔断中跳过、providerErrors 透传
- 新增 `cache-lru.test.mjs`（9 项）：cache/imgCache LRU 淘汰、读命中刷新 LRU、TTL 过期
- 新增 `crop-enlarge.test.mjs`（10 项）：cropAndEnlarge 整图/半图/越界/1x1/无效输入/bbox 0 宽度
- 新增 `metrics.test.mjs`（8 项）：/metrics 端点存在、零计数、计数累加、p50/p95/p99、X-Request-Id 客户端传入/自动生成、/metrics 自身不计入请求
- 新增 `ux-routing-history.test.mjs`（11 项）：routeTaskByContext 显式优先 / 关键词命中 / 无匹配保持 general / 多语言 / history 不落盘 force_action
- 新增 `image-processing.test.mjs`（14 项）：chooseFormat 照片/UI/带 alpha/无效、sliceLongImage 正方/横长/竖长/比例 ≤3/极长/无效、ocrPreprocess 输出格式/尺寸/无效
- 新增 `integration.test.mjs`（14 项，端到端整合性）：/health /metrics /analyze 全链路、多图、缺参 400、不存在文件 400、未知路由 404、raw=1 透传、crop_bbox 透传、POST base64、task 自动路由、X-Request-Id、cache 语义
- 新增 `completeness.test.mjs`（17 项，完整性一致性）：版本号三处一致、README/CONFIG/USAGE/SKILL 关键字、响应 schema 字段齐全、CACHE_MAX/METRICS_WINDOW_MS 与代码常量一致、MCP 工具参数
- 新增 `stress.test.mjs`（13 项，压力测试）：100 次连续 / 20 并发 / 200 次 metrics 累加 / P95 延迟 / cache.size 上限 / 连续错误不崩 / 混合请求 / POST 并发 / 字节缓存稳定 / 滚动窗口 P50≤P95≤P99
- 新增 `usage.test.mjs`（28 项，用户使用层面端到端）：A 喂图 4 种方式（路径/最新截图脚本/粘贴提取/base64）、B 任务场景（报错路由/显式优先/多图对比/多轮追问/精准放大/反向验证/OCR/stop）、C 历史回看、D 用户视角可观测性（X-Request-Id/metrics 维度）、E 错误体验（缺参/不存在/超限/空 base64/非法 bbox/未知 task）、F 图像处理（JPEG/超长图/混合格式）、G /health /metrics 用户感知
- `npm test` 改用 `--test-isolation=process`：每个测试文件独立进程，避免多文件并行操作模块级 Map 互相污染（跨平台都受益）
- `analyzeImage()` 加 `axiosInstance` 注入参数，便于 mock HTTP 不调真实模型
- 总测试数 175 → 203，全部通过

### 文档

- SKILL.md 新增 1.1（task 自动路由）/ 1.2（多图打标签）/ 1.3（分析历史）三节
- vision-client.js 导出 `_CIRCUIT` / `_FAILURE_THRESHOLD` / `_resetCircuit` 便于测试

## [1.3.0] - 2026-08-17

### 新增

- **`response_format: json_object` 强制 JSON 输出**：vision-client 调用上游模型时默认开启 `response_format: { type: 'json_object' }`，主流云厂商（智谱 / OpenAI / 通义 / 豆包等）模型直接吐合法 JSON，解析失败率显著下降。Ollama 等不支持的 provider 可在 `vision-config.json` 里加 `"disable_json_mode": true` 跳过；本地 11434 端口/name 含 ollama 时会自动识别并关。
- **Provider 指数退避重试 + 熔断**：对 429/5xx/超时/连接重置等瞬时错误，同一 provider 内先重试 2 次（500ms → 1s 指数退避）再切下一个；连续失败 3 次的 provider 被熔断 5 分钟，期间直接跳过不再尝试，5 分钟后放一次试探。原先死代码 `isTransientError()` 正式启用。
- **图片字节缓存 + 多图并行压缩**：同一张图换 desc/focus 第二次分析时，sharp 压缩步骤直接命中缓存跳过（TTL = 分析缓存的 2 倍）；多图压缩从 `for...of` 串行 await 改为 `Promise.all` 并行，6 张图总耗时 ≈ 单张耗时。响应 `images[].compressed_bytes` 字段从恒为 null 改为实际填充。
- **`crop_bbox` 精准放大追问**：bridge `/analyze` 接受 `crop_bbox={x,y,w,h}`（归一化，0~1 / 0~100 / 0~1000 尺度自适应），按 bbox 裁剪第 0 张图原图并放大到最小边 800px 后再交给模型。配合上一轮 `regions[].bbox` 做"细看某区域"的多轮追问，精度大增。响应 `meta` 加 `crop_bbox` 和 `cropped` 字段。
- **`POST /analyze` 远程上传**：修复远程部署 path 漏洞——集中式 MCP 下 bridge 服务器读不到员工本地文件，新增 `POST /analyze` 接口收 base64 图片字节（body 上限 64MB）。MCP 工具 schema 加 `image_base64` / `images_base64` 参数，skill 自动判断走 POST 还是 GET。
- **远程 HTTP 鉴权用 `timingSafeEqual`**：`server-http.js` 的 `authorized()` 从 `===` 改为 `crypto.timingSafeEqual`，消除时序攻击风险。

### 文档

- SKILL.md 新增 `crop_bbox` / `image_base64` 参数说明 + 1.6 节「精准放大追问」引导
- docs/DEPLOY.md 修正方案 A 描述：员工本地路径在 bridge 服务器读不到，远程模式必须用 base64 上传
- docs/CONFIG.md 补 `disable_json_mode` 字段、`POST /analyze` 调试端点、重试与熔断行为说明
- docs/USAGE.md 补 `crop_bbox` / `image_base64` 用法场景
- README.md Features 补 3 项新能力
- vision-config.example.json 加 `disable_json_mode` 注释示范

### 测试

- 新增 `parseCropBbox` 单测（尺度自适应 / 越界修正 / 非法返回 null）
- 新增 POST /analyze smoke（base64 上传 + crop_bbox 端到端）

## [1.2.1] - 2026-08-14

### 修复

- MCP 连接超时从 30s 调大到 120s，避免被 claude-mem 等插件的同步启动 hook 拖成 CONNECT_TIMEOUT
- 自检桥接失败时打印桥接的真实报错（原为笼统提示，无法定位缺依赖/端口占用等原因）

## [1.2.0] - 2026-08-14

### 新增

- **focus 多轮追问**:`analyze_image` 新增 `focus` 参数,让视觉模型定向细看指定区域,实现"粗看 → 追问细节"的多轮视觉问答
- **regions 归一化坐标**:视觉模型输出标注区域/关键元素的 bbox(归一化 [0,1],尺度自适应),把视觉位置对齐到代码坐标/布局
- **verbatim 原文兜底**:报错堆栈/报错消息/错误码/日志的逐字原文独立字段,不再被 analysis 概括吞掉
- **task=verify 反向验证**:把推理结论作为断言发回视觉模型核验,返回结构化 verdict(true/false/uncertain)+ evidence
- **修复**:缓存 key 纳入 desc/focus(原缓存 key 未含 desc,不同描述会命中同一条缓存)

### 文档

- SKILL.md 新增「多轮追问」「反向验证」引导;README 补充新能力说明

## [1.1.0] - 2026-08-14

### 新增

- **多图分析**:`analyze_image` 支持 `paths`(最多 6 张)一次分析;桥接 `images` 数组响应、合并缓存
- **task=diff**:多图差异对比(分别描述每张,再列差异)
- **keywords 输出 + 自动定位代码**:分析结果带可用于检索的关键词,skill 引导在当前项目 grep 到 `文件:行号`
- **标注识别泛化**:识别所有非原图的用户附加标注(框选/高亮/圆圈/箭头/手写/批注等),逐字转录到 `annotated_text`
- **`extract-pasted-image --count N`**:一次提取最近 N 张粘贴图
- **全新升级体验**:
  - `setup --upgrade`:一键"先卸载旧版,再安装全新版本"(老 v1.00 就地用户升级用)
  - 版本跟踪:`installed-version`,升级时打印 `v旧 → v新`
  - 配置备份:`vision-config.json.bak`
  - `--install`(新用户唯一标准)/ `--update`(固定安装升级)/ `--uninstall`
- **修复**:Windows 上 `fs.cpSync` 复制含 `.git` 的目录树原生崩溃(exit 127)→ 改手工递归复制

### 文档

- README / QUICKSTART / docs(DEPLOY/USAGE/CONFIG)增加「升级」说明(三类用户各自的升级路径)

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
