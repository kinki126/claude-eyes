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
| `ocr` | 纯文字提取 |

## 连续多图分析与停/续控制

这是本系统的核心行为。视觉模型分析每张图后，会在响应里给出 `control.action`：

- **`continue`** → 当前是中间态，Claude 呈现结果后**等待你提供下一张图**（可回复"继续"或直接贴下一张）。
- **`stop`** → 截图显示任务完成/流程结束，Claude 总结并**结束本次分析流程**，不再请求更多图片。

桥接进程保持存活，但本次"分析流程"是否继续由模型按图内容自主决定。

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

默认情况下，claude-eyes 的 `.mcp.json` 与 skill 是**项目级**的，只在 claude-eyes 自己那个文件夹里生效。如果你希望**任何项目**（如 Vue3 项目）里都能分析图片，做一次"用户级安装"：

```bash
# 1. 把 MCP 工具注册到用户级（对所有项目生效）
claude mcp add image-analyzer -s user \
  -e BRIDGE_BASE_URL=http://127.0.0.1:8765 \
  -e BRIDGE_SCRIPT_PATH="E:/temp/zhipu-bridge-api.js" \
  -e AUTO_SPAWN_BRIDGE=1 \
  -e MCP_USER=<你的标识> \
  -- node "E:/temp/mcp-image-analyzer/index.js"

# 2. 把 analyze-image skill 复制到用户级，并把里面的脚本路径改成 claude-eyes 的绝对路径
#    （本仓库 .claude/skills/analyze-image/SKILL.md 即模板）
```

装好后，**重启 Claude**，在任何项目目录里启动都能直接粘贴图片 / 说"分析最新一张截图"。

> 注意：若项目根已存在 `.mcp.json`（含同名 server），会与用户级冲突——保留一个、删除另一个即可（`claude mcp remove image-analyzer -s user` 或删项目 `.mcp.json`）。
