# 使用说明（各种场景）

## 喂图方式

### 场景 1：VS Code 面板粘贴（Trae 式，最顺手）

1. 打开 VS Code 的 Claude Code 插件面板。
2. `Ctrl+V` 粘贴截图。
3. **按回车**发送。

由于 skill 的「自动触发」规则，消息里只有图片、没有指令时，Claude 会**默认当作"分析这张图"直接执行**，无需你再打字。

> 注意：面板粘贴的图不会落盘成文件，而是以 base64 内嵌在会话转录里。系统会自动提取（`extract-pasted-image.mjs`）后交给视觉模型。

### 场景 2：截图自动保存（零操作）

1. 打开系统"截图工具"（Snipping Tool）→ 设置 → 开启"**自动保存屏幕截图**"。
2. `Win+Shift+S` 框选截图，图片自动存到"图片\屏幕截图"。
3. 回 Claude 说："**分析最新一张截图**"。

系统会在 `<项目根>\shots` 与系统截图目录里找最新的一张。

### 场景 3：直接给路径（最稳）

```text
分析 E:\temp\shot.png
看下 E:\data\logs\error-screen.png 的报错
```

## 分析任务类型

调 `analyze_image` 时可用 `task` 参数指定侧重：

| task | 用途 |
|---|---|
| `general`（默认） | 全面提取（文字/报错/界面） |
| `error` | 报错定位：错误类型、堆栈、错误码、触发条件、修复思路 |
| `ui` | 界面走查：元素、布局、文案、操作状态 |
| `ocr` | 纯文字提取（v1.4.0 起自动启用二值化预处理，文字识别更准） |
| `diff` | **多图差异对比**：分别描述每张图，再列出图与图之间的差异（新增/删除/变化） |

### task 自动路由（v1.4.0 新增）

用户没显式传 `task` 时，bridge 会扫描 `desc` + `focus` 关键词自动切到对应专项 task——**用户少说一句话也能选对模板**：

| 关键词命中 | 自动切到 |
|---|---|
| 报错 / 错误 / exception / stack trace / 崩溃 / traceback / 错误码 / panic / fatal | `error` |
| 对比 / diff / 之前 / 之后 / 差异 / 比较 / before / after / 变化 | `diff` |
| 文字 / 提取文字 / ocr / 转录 / 识别文字 / 内容是什么 | `ocr` |
| 界面 / 布局 / 按钮 / 走查 / 元素 / 组件 / 样式 | `ui` |

- 用户**显式传 `task`** 时永远以用户指定为准，路由不覆盖
- Claude 在自己构造 `description` 时可主动写关键词触发路由（"分析这张报错截图" → 自动切 error）

## 一次分析多张图（对比/批量）

支持一次传最多 **6 张图** 给视觉模型一起分析（可 `task=diff` 做对比）：

- **面板粘贴多张**：一次贴多张图 → 回车，skill 会自动提取多张并一起分析。
- **路径多张**：说"分析 `E:\a.png` 和 `E:\b.png`，对比差异"，Claude 会传 `paths`。
- **对比两张图**：`task=diff`，模型输出"图 A vs 图 B 的差异"。

### 多图打标签（v1.4.0 新增）

多图分析时**不要只传 paths 让模型瞎猜**——在 `description` 里显式给每张图打标签：

```text
# 用户："对比 a.png 和 b.png，看修复前后差异"
description = "图1: 修复前 / 图2: 修复后"
paths = ["a.png", "b.png"]
task = "diff"  # 或不传，自动路由命中"对比"
```

标签来源优先级：① 用户消息里的语境（"修复前/后""之前/之后""设计稿/实现"）→ 直接用；② 截图时间序（3 张按 mtime 排）→ 自动标"图1: 最早 / 图2: 中间 / 图3: 最新"；③ 都没有 → 退化为"图1 / 图2 / 图3"。

> 分析结果里会附带 `keywords`（报错函数名/错误码/文件名等，可用于代码检索）。Claude 会用它们在当前项目里 grep，报告命中的 `文件:行号`，帮你直接定位到问题代码。

## 连续多图分析与停/续控制

这是本系统的核心行为。视觉模型分析每张图后，会在响应里给出 `control.action`：

- **`continue`** → 当前是中间态，Claude 呈现结果后**等待你提供下一张图**（可回复"继续"或直接贴下一张）。
- **`stop`** → 截图显示任务完成/流程结束，Claude 总结并**结束本次分析流程**，不再请求更多图片。

桥接进程保持存活，但本次"分析流程"是否继续由模型按图内容自主决定。

## 精准放大追问（`crop_bbox`）

第一轮 `focus` 只告诉模型"看哪里"，模型仍在缩放后的整图上找；遇到超长截图或小区域会糊成马赛克。这时用上一轮返回的 `regions[].bbox` 作为 `crop_bbox` 传回，bridge 会从**原图**按 bbox 裁剪并放大到最小边 800px 再交给模型：

```text
（第一轮）
分析 E:\shot.png
→ 返回 regions: [{ label: "报错堆栈", bbox: { x:0.05, y:0.02, w:0.40, h:0.12 } }]

（第二轮，精准放大）
细看红框里的报错文字，一字不差转录
→ Claude 自动带 focus + crop_bbox={x:0.05, y:0.02, w:0.40, h:0.12} 调一次
→ meta.cropped: true 表示 bridge 实际执行了裁剪放大
```

**何时用 `crop_bbox` 而不是裸 `focus`**：
- 第一轮 `regions` 里有 `bbox`，且对应区域 < 整图 1/3；
- 报错堆栈/UI 文字在第一轮 `verbatim` 里残缺，但 `regions` 定位到了该区域；
- 用户明确说"细看左上角那块""放大第 2 个按钮"。

## 远程 MCP 模式：base64 上传图片

集中式远程部署下，bridge 跑在服务器、图片在员工本地，原 `path` 参数无法工作。`analyze_image` 工具为此加了 `image_base64` / `images_base64` 参数，由 skill 自动判断走 `POST /analyze`：

```text
分析这张报错（远程模式下粘贴的图）
→ Claude 把 base64 透传给 image_base64 参数 → POST /analyze → 返回结构与 GET 一致
```

- 单张用 `image_base64`，多张用 `images_base64: [b64, b64, ...]`（最多 6 张）
- base64 内容**不带** `data:image/png;base64,` 前缀（带前缀也兼容，bridge 自动剥离）
- 本地模式仍优先用 `path`/`paths`（GET /analyze），不强制走 POST

## 排查与状态解读

### 分析结果字段

```jsonc
{
  "analysis": { "text": "分析内容", "raw": "模型原始输出" },
  "control": { "action": "continue|stop", "reason": "原因", "flow_state": "active|ended" },
  "meta": {
    "parse": "ok|fallback|failed",   // 解析是否成功
    "cache": "hit|miss",             // 是否命中缓存
    "latency_ms": 1234
  }
}
```

- `meta.parse: "ok"` → 内容完整可信。
- `meta.parse: "failed"/"fallback"` → 模型输出未完全按 JSON 解析（常因被截断），内容仍可读，但可能不完整——可要求"重新分析"。
- `meta.cache: "hit"` → 同一张图刚分析过，秒回缓存。
- `meta.cropped: true` → 本轮执行了 crop_bbox 裁剪放大（v1.3.0+）。
- `meta.slices: 3` → 原图超长被切成 3 段（v1.4.0+）。
- `meta.request_id: "r-..."` → 本次请求的 trace id，与响应头 `X-Request-Id` 一致（v1.4.0+）。

### 图像处理增强（v1.4.0）

bridge 自动按图本身特征优化输入：

- **格式自适应**：照片类截图（jpeg/webp 来源无 alpha）→ WebP q=80，体积降 80%+，省 API token；UI/文字截图 → PNG 无损，文字清晰。
- **超长图切片**：整页网页截图 / 长报错堆栈 / 聊天记录截图（长宽比 > 3）→ 自动切成 2-5 段，每段间 10% 重叠避免关键信息被切到中间，每段独立压缩保持清晰度。响应 `meta.slices` 透传切片数。仅单图启用（多图保持原样避免顺序混乱）。
- **OCR 二值化**：`task=ocr` 时自动做灰度 + 直方图均衡 + 阈值二值化，彩色背景上的小字、密集文字识别率立升。其他 task 保留原色（UI 需要看颜色判断按钮状态/品牌色）。

### 分析历史（v1.4.0）

每次成功的分析（非 `force_action`）自动追加一行到 `<项目根>\.claude-eyes\history.jsonl`：

```jsonl
{"ts":"2026-08-17T10:23:00Z","request_id":"r-...","user":"local","md5":"abc...","image_count":1,"task":"error","action":"stop","analysis":"...","keywords":["TypeError","renderX"],"regions":[...],"cache":"miss","latency_ms":1234}
```

**回看历史**：用户说"昨天那张 TypeError 的图重新看一下"→ Claude 可以：

```bash
Get-Content .claude-eyes\history.jsonl | Select-String "TypeError"
```

找到 md5 / 路径线索，再用 `analyze_image` 重新跑（1 小时内 cache hit 秒回）。

### 常见问题

| 现象 | 处理 |
|---|---|
| 报"桥接未启动，且自动拉起失败" | 手动 `node zhipu-bridge-api.js`，确认 8765 端口 |
| 报"文件不存在" | 路径写错了；Windows 路径用反斜杠，且要完整绝对路径 |
| 粘贴图片后 Claude 说看不到图 | 改用场景 2 或 3；面板粘贴请确认按了回车 |
| 报"未找到图片" | 截图保存到 `<项目根>\shots` 或系统截图目录后再试 |
| 被限流（HTTP 429） | 稍等片刻；管理员可调 `RATE_LIMIT_PER_MIN` |
| `api_key` 为空分析失败 | `node setup.mjs --reset-key` 重新配置 |

## 在任意 Claude 项目中使用（用户级安装）

默认情况下，claude-eyes 的 `.mcp.json` 与 skill 是**项目级**的，只在 claude-eyes 自己那个文件夹里生效。如果你希望**任何项目**（如 Vue3 项目）里都能分析图片，做一次"用户级安装"。

**最简单（推荐）：一条命令（默认就是用户级）**
```bash
node setup.mjs
```
它会自动：注册 MCP 到用户级（`claude mcp add -s user`）+ 安装 skill 到 `~/.claude/skills/`（脚本路径自动填成绝对路径）。
> 若只想在 claude-eyes 当前文件夹生效（项目级），用 `node setup.mjs --project-level`。

**手动方式（等价）**
```bash
# 1. 把 MCP 工具注册到用户级（对所有项目生效）
claude mcp add image-analyzer -s user \
  -e BRIDGE_BASE_URL=http://127.0.0.1:8765 \
  -e BRIDGE_SCRIPT_PATH="E:/temp/zhipu-bridge-api.js" \
  -e AUTO_SPAWN_BRIDGE=1 \
  -e MCP_USER=<你的标识> \
  -- node "E:/temp/mcp-image-analyzer/index.js"

# 2. 手动加连接超时：claude mcp add 不支持 timeout 参数，直接编辑 ~/.claude.json，
#    在 mcpServers.image-analyzer 里加 "timeout": 120000（毫秒）。
#    否则 claude-mem 等插件的同步启动 hook 可能把默认 30s 超时拖成 CONNECT_TIMEOUT。

# 3. 把 analyze-image skill 复制到用户级，并把里面的脚本路径改成 claude-eyes 的绝对路径
#    （本仓库 .claude/skills/analyze-image/SKILL.md 即模板）
```

装好后，**重启 Claude**，在任何项目目录里启动都能直接粘贴图片 / 说"分析最新一张截图"。

> 注意：若项目根已存在 `.mcp.json`（含同名 server），会与用户级冲突——保留一个、删除另一个即可（`claude mcp remove image-analyzer -s user` 或删项目 `.mcp.json`）。
