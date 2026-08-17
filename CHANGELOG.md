# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-08-17

### 新增

- **可观测性 /metrics 端点**：bridge 暴露 `/metrics`，返回 JSON 报告（uptime / total_requests / total_errors / error_rate / cache_hit_rate / latency_p50/p95/p99_ms / by_task / by_provider / by_user / error_types），10 分钟滚动窗口。配 Prometheus + Grafana 直接看 QPS / P95 / 错误率。
- **`X-Request-Id` 贯穿**：每个 bridge 响应带 `X-Request-Id` 头（客户端传入则原样回，否则自动生成 `r-<ts>-<rand>`）；响应 `meta.request_id` 同步透传；usageLog / historyLog 都记录 request_id，便于跨日志排查"哪一环慢"。MCP 工具自动生成 `mcp-<uuid>` 传给 bridge。
- **task 自动路由**：bridge 扫描 `desc` + `focus` 关键词，自动把 `general` 切到对应专项 task——用户没显式传 task 时尤其实用：
  - 报错 / 错误 / exception / stack trace / 崩溃 / traceback / 错误码 / panic / fatal → `error`
  - 对比 / diff / 之前 / 之后 / 差异 / 比较 / before / after / 变化 → `diff`
  - 文字 / 提取文字 / ocr / 转录 / 识别文字 / 内容是什么 → `ocr`
  - 界面 / 布局 / 按钮 / 走查 / 元素 / 组件 / 样式 → `ui`
  - 用户显式传 task 时永远以用户指定为准。
- **分析历史持久化**：每次成功的分析（非 force_action）自动落盘到 `<项目根>/.claude-eyes/history.jsonl`，每行一条 JSON（含 ts / request_id / user / md5 / task / action / analysis / keywords / regions / cache / latency_ms）。用户说"昨天那张 TypeError 的图重新看一下"→ Claude 可以 grep history 找 md5 重新分析（1 小时内 cache hit 秒回）。
- **图像格式自适应**：bridge 按 source media type 自动选输出格式——照片类（jpeg/webp 来源且无 alpha）转 WebP q=80，体积降 80%+，传输/成本受益；UI/文字截图保持 PNG 无损，文字清晰。`chooseFormat()` 启发式判断。
- **超长图切片**：长宽比 > 3 的图按高度（竖长）或宽度（横长）切成 2-5 段，每段间 10% 重叠避免关键信息被切到中间；每段独立压缩保持清晰度。`sliceLongImage()` 仅对单图启用（多图场景保持原样避免顺序混乱）。响应 `meta.slices` 字段透传实际切片数。整页网页截图 / 长报错堆栈 / 聊天记录截图文字识别率大增。
- **OCR 二值化预处理**：`task=ocr` 时对图做灰度 + 直方图均衡 + 阈值二值化再传给模型，彩色背景上的文字、小字、密集文字识别率立升。`ocrPreprocess()` 仅对 ocr task 启用，其他 task 保留原色（UI 需要看颜色判断按钮状态/品牌色）。

### 修复

- **`isCircuitOpen` 状态误删 bug**：改前 `openUntil=0`（未熔断状态）时 `Date.now() > 0` 会触发"窗口到期"分支 delete 状态，导致 `markFailure` 累积的失败计数被悄悄清零，**熔断永远触发不了**。改后 `if (s.openUntil === 0) return false;` 未熔断状态保留 failures 计数。测试驱动发现。

### 测试

- 新增 `vision-client.test.mjs`（20 项）：熔断状态机流转、provider failover 链路、重试 2 次后成功、连续 3 次失败触发熔断、熔断中跳过、providerErrors 透传
- 新增 `cache-lru.test.mjs`（9 项）：cache/imgCache LRU 淘汰、读命中刷新 LRU、TTL 过期
- 新增 `crop-enlarge.test.mjs`（10 项）：cropAndEnlarge 整图/半图/越界/1x1/无效输入/bbox 0 宽度
- 新增 `metrics.test.mjs`（8 项）：/metrics 端点存在、零计数、计数累加、p50/p95/p99、X-Request-Id 客户端传入/自动生成、/metrics 自身不计入请求
- 新增 `ux-routing-history.test.mjs`（11 项）：routeTaskByContext 显式优先 / 关键词命中 / 无匹配保持 general / 多语言 / history 不落盘 force_action
- 新增 `image-processing.test.mjs`（14 项）：chooseFormat 照片/UI/带 alpha/无效、sliceLongImage 正方/横长/竖长/比例 ≤3/极长/无效、ocrPreprocess 输出格式/尺寸/无效
- `npm test` 改用 `--test-isolation=process`：每个测试文件独立进程，避免多文件并行操作模块级 Map 互相污染（跨平台都受益）
- `analyzeImage()` 加 `axiosInstance` 注入参数，便于 mock HTTP 不调真实模型

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
