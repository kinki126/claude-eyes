---
name: analyze-image
description: 分析本地截图/图片（报错、界面、文字），支持多张图一起分析/对比。当用户要求"分析这张截图/图片""分析最新一张截图""看下这个报错""看看这个界面""对比这几张图"，或用户直接粘贴了一张或多张截图/图片（对话里出现 [Image] 引用）时使用。
---

# 图片分析流程

> 提示：本 skill 里所有脚本命令都**相对项目根**运行（Claude 的当前目录就是项目根，如 `E:\temp`），不需要写绝对路径。

## 自动触发（粘贴即分析，无需用户说"分析这张图"）

当用户消息里**只包含粘贴的图片**（对话里有 `[Image]` 引用，文字为空或只是"这个/看看/啥"这类无明确指令的碎片）、**没有明确的其他任务**时：
- 默认意图 = 分析这张图片。**直接执行本流程**，不要反问"你想让我做什么"，也不要说"当前模型不支持看图"之类的话。
- 按下方第 0 节的路径规则解析出真实路径 → 调 `analyze_image` → 呈现结果。
- 只有当路径解析彻底失败（脚本 exit 1、或确实拿不到任何路径）时，才向用户说明并请其换一种方式给图（保存到项目根的 `shots\` 目录或直接给路径）。

## 0. 图片路径怎么来（按优先级）

1. 用户直接给了路径（如 `分析 <项目根>\shot.png`）→ 用它。
2. 用户**粘贴**了图片：对话里会出现 `[Image #N]` 引用，同时带有源文件路径（形如 `source: ...` 或 `[Image: source: ...]`）。**从该 source 提取真实本地绝对路径**，作为 `path` 传给工具。
   - `[Image #N]` 占位符本身不是路径，绝不能直接当参数用。
   - 即使显示 `[Unsupported Image]`（后端无视觉），只要对话里有 `source:` 路径，就走这条路。
   - 若 source 路径是临时目录，直接透传即可——桥接按绝对路径读本地文件。
3. 用户**在 VS Code 插件面板里粘贴**了图片（对话里有 `[Image]` 引用、但**没有** `source:` 路径——面板粘贴的图以 base64 内嵌在会话转录里，**不落盘**）→ **一律走这一步**：运行 `node extract-pasted-image.mjs`，按返回结果处理：
   - **多张图**（用户一次贴了多张、或要求"对比/一起看这几张"）：运行 `node extract-pasted-image.mjs --count N`（N=本次图片引用数，上限 6），得到每行一个路径 → 调 `analyze_image` 的 `paths`（一次分析多张，可 `task=diff` 对比）。
   - **单张**（默认）：输出最新一张 → 用 `path` 分析。
   - 输出 **`SAME:<路径>`** → 转录里最新的图就是已提取过的那张（**本次没有新粘贴**）。告诉用户"没检测到新的粘贴"，并可用 `--count` 取最近几张或请其重新粘贴。
   - **exit 1**（报"未找到"）→ 粘贴没成功（对话里无 `[Image]` 引用），提示用户重新粘贴或直接给路径。
   - ⚠️ **绝不要**用 `shots\` 目录里 mtime 最新的文件来猜"用户刚粘贴的图"——落盘会滞后于转录（新粘贴的图可能还没被解码出来），会取到旧图，分析就错了。
4. 用户说"**分析最新一张截图**""看下刚截的图"（未给路径）：运行 `node latest-shot.mjs`，用输出的路径作为 `path`。若脚本报"未找到图片"，提示用户先把截图保存到项目根的 `shots\`（或开启截图工具自动保存）。
5. 都拿不到（没路径、没粘贴、没最新截图）→ 询问用户图片文件路径。

## 1. 调用 `analyze_image`

传入本地图片**绝对路径**（Windows 格式，如 `<项目根>\shot.png`，直接透传，不要转成 POSIX 风格）。可选参数：
- `path`：单张（与 `paths` 或 `image_base64` 三选一）
- `paths`：多张（最多 6 张），模型会一起分析/对比
- `image_base64` / `images_base64`：图片 base64 内容（不带 `data:image/png;base64,` 前缀）。**远程 MCP 模式下** bridge 服务器读不到客户端本地文件，必须改用 base64 上传；本地模式优先用 `path`/`paths`
- `task`：`error`=报错定位 / `ui`=界面走查 / `ocr`=纯文字提取 / `diff`=多图差异对比 / `general`=全面分析（默认）
- `lang`：`zh`（默认）或 `en`
- `description`：用户的文字描述，会透传给视觉模型
- `focus`：重点关注区域/问题（自然语言，如"左上角红框里的报错文字""第 3 个按钮的文案"），让视觉模型定向细看，多轮追问用
- `crop_bbox`：按归一化 bbox `{x,y,w,h}`（0.0~1.0）裁剪第 0 张图并放大后再分析，**取值来自上一轮返回的 `regions[].bbox`**，配合 `focus` 做精准放大追问

### 1.1 task 自动路由（用户不说也能选对）

bridge 会扫描 `description` + `focus` 里的关键词，自动把 `general` 切到对应专项 task，**用户没显式传 task 时尤其实用**：

| 关键词（任一命中即切） | 自动切到 task |
|---|---|
| 报错 / 错误 / exception / stack trace / 崩溃 / traceback / 错误码 / error code / panic / fatal | `error` |
| 对比 / diff / 之前 / 之后 / 差异 / 比较 / before / after / 变化 | `diff` |
| 文字 / 提取文字 / ocr / 转录 / 识别文字 / 内容是什么 | `ocr` |
| 界面 / 布局 / 按钮 / 走查 / ui review / 元素 / 组件 / 样式 | `ui` |

- 用户**显式传 `task`** 时永远以用户指定为准，路由不覆盖。
- Claude 在自己构造 `description` 时可以**主动写关键词**触发路由（如"分析这张报错截图" → 自动切 error），不需要再传 `task`。

### 1.2 多图打标签（让模型分清每张图的角色）

多图分析时，**不要只传 paths 让模型瞎猜**——在 `description` 里**显式给每张图打标签**：

```
# 用户："对比 a.png 和 b.png，看修复前后差异"
description = "图1: 修复前 / 图2: 修复后"
paths = ["a.png", "b.png"]
task = "diff"  # 或不传，自动路由命中"对比"
```

标签来源优先级：
1. **用户消息里的语境**（"修复前/后""之前/之后""设计稿/实现"等）→ 直接用；
2. **截图时间序**（3 张按 mtime 排序）→ 自动标"图1: 最早 / 图2: 中间 / 图3: 最新"；
3. 都没有 → 退化为"图1 / 图2 / 图3"。

打标签让模型清楚每张图的角色，diff/对比场景准确率显著提升。

### 1.2.1 diff 结构化输出（v1.6.0+）

`task=diff` 返回的 `analysis` 字段除了常规 `text` 外，还会带一个 `diffs` 数组，逐项列出各图之间的差异：

```json
"diffs": [
  { "item": "提交按钮颜色", "from": "灰色", "to": "蓝色", "change_type": "modify", "image_index": 1, "bbox": { "x": 0.3, "y": 0.6, "w": 0.15, "h": 0.08 } },
  { "item": "标题文案", "from": "", "to": "新版", "change_type": "add", "image_index": 1, "bbox": { "x": 0.1, "y": 0.05, "w": 0.3, "h": 0.05 } }
]
```

- `change_type`: `add`（图1无图2新增）/ `remove`（图1有图2删）/ `modify`（两图都有但变化）
- `bbox` 是差异区域的归一化坐标，用户说"细看第 2 处改动"时可作 `crop_bbox` 传回精准放大
- 超过 3 个变化点时，**Claude 应用 markdown 表格呈现**：`| # | 差异项 | 图1 | 图2 | 类型 |`，让用户一眼看清

### 1.3 分析历史（自动落盘，可回看）

每次成功的分析（非 `force_action`）都会自动落盘到 `<项目根>\.claude-eyes\history.jsonl`，每行一条 JSON：

```jsonl
{"ts":"2026-08-17T10:23:00Z","request_id":"r-...","user":"local","md5":"abc...","image_count":1,"task":"error","action":"stop","analysis":"...","keywords":["TypeError","renderX"],"regions":[...],"cache":"miss","latency_ms":1234}
```

**回看历史**（v1.6.0+ 起推荐用 `search_history` 工具）：
- 用户说"昨天那张 TypeError 的图重新看一下" → 调 `search_history(keyword="TypeError", since="2026-08-16")` 返回结构化结果
- 支持过滤：`task`（任务类型）、`keyword`（analysis 文本 + keywords 数组模糊匹配）、`since/until`（时间范围）、`limit`（默认 20 上限 100）
- 旧方式仍可用：`Get-Content .claude-eyes\history.jsonl | Select-String "TypeError"` 找到 md5/路径线索，再用 `analyze_image` 重新跑（1 小时内 cache=hit 秒回）。

## 1.5 多轮追问（第一轮拿不准就带 `focus` 再问）

不要指望一次描述看清一切。第一轮返回后，若出现以下任一情况，**带 `focus` 再调一次 `analyze_image`（同一张图/同一批图）**，而不是直接给结论：

- 报错文字/堆栈不完整（`analysis` 里出现"某处报错""上方有错误"这类含糊措辞）；
- 用户标注区域（`annotated_text`）为空或没看清；
- 需要看某个具体区域/元素，但第一轮是整体描述、没有细节。

`focus` 用自然语言描述"看哪里 + 想问什么"，例如：
- `focus: "左上角红框里的报错文字，一字不差转录"`
- `focus: "第 3 个按钮的文案和禁用状态"`
- `focus: "浏览器地址栏与状态栏，确认是否加载失败"`

视觉模型会把 `focus` 当最高优先级、定向细看并围绕它作答。追问 1–2 轮通常足够，不要无限循环。

> **P0-1 上下文自动继承**（v1.5.0+）：bridge 会自动把上一轮的 `{ task, keywords, regions, analysis 摘要 }` 注入到本轮 prompt 里。**你不需要在 `focus` 里重复交代「就是刚才那张图的 xxx 位置」**——bridge 已经告诉模型了。响应里 `meta.context_inherited: true` 表示本轮注入了上一轮上下文。

## 1.6 精准放大追问（带 `crop_bbox`，比单 `focus` 看得更清）

`focus` 只告诉模型"看哪里"，模型仍在整张缩放后的图上找——超长截图或小区域会糊成马赛克。**若上一轮返回了 `regions` 且带 `bbox`，把它作为 `crop_bbox` 传回**，bridge 会从原图按 bbox 裁剪并放大到最小边 800px 后再交给模型：

```
# 第一轮返回里出现：
"regions": [{ "label": "报错堆栈", "bbox": { "x": 0.05, "y": 0.02, "w": 0.40, "h": 0.12 } }, ...]

# 第二轮（追问该区域细节）：
analyze_image(path=同一张, focus="红框里的报错文字一字不差转录",
              crop_bbox={x:0.05, y:0.02, w:0.40, h:0.12})
```

**触发条件**（满足任一即用 `crop_bbox` 而非裸 `focus`）：
- 第一轮 `regions` 里有 `bbox`，且对应区域 < 整图 1/3；
- 报错堆栈/UI 文字在第一轮 `verbatim` 里残缺、但 `regions` 里定位到了该区域；
- 用户明确说"细看左上角那块""放大第 2 个按钮"。

**注意**：
- `crop_bbox` 只作用于第 0 张图（多图场景下其他图按原样传）；
- bbox 坐标尺度自适应（0~1 / 0~100 / 0~1000 均可），但**推荐直接用第一轮返回的归一化值（0~1）**，省心；
- `meta.cropped: true` 表示 bridge 实际执行了裁剪放大，可据此判断本轮结果是否来自放大版。

## 2. 向用户**完整呈现**返回的 `analysis` 内容

注意 `meta.parse`：
- `parse: "ok"` → 内容完整可信。
- `parse: "failed"` / `"fallback"` → 模型输出未完全按 JSON 解析（可能是被截断），把 `analysis` 里的原始内容照常呈现给用户，并提示"内容可能不完整，需要的话可重新分析"。

**若返回里有 `annotated_text`（用户附加标注区域内文字的逐字转录，如框选/高亮/箭头/手写批注等）**：这是用户最关注的内容，务必**单独醒目地呈现**，并把它作为分析/定位的核心线索。

**若返回里有 `verbatim`（报错堆栈/报错消息/错误码/日志的完整逐字原文）**：同样**单独醒目地呈现**，它是 `analysis` 概括之外的原文兜底；分析/定位报错时**以 `verbatim` 为准**，不要用 `analysis` 里的概括代替。

## 3. 自动定位到项目代码（可选增强）

返回的 `regions` 是标注区域/关键元素的**归一化坐标**（每条 `bbox` 的 `x/y/w/h` 都在 0.0~1.0，相对整张图）。若截图对应某个已知窗口/组件，可用它把"图里的位置"映射到"代码里的坐标/布局"（例如前端组件在页面中的相对位置、截图裁剪用的 ROI 比例）；结合 `keywords` 一起定位，比单靠文字更准。

返回的 `keywords` 是可用于代码检索的关键词（报错函数名 / 错误码 / 文件名 / 接口路径等）；`annotated_text` 是用户附加标注区域的逐字转录，**优先用它**。当它们非空、且当前是代码项目时：

- **优先用 `locate_code` 工具**搜索（比直接 grep 更结构化，返回 `{ file, line, match }` 候选列表）：
  ```
  locate_code(keywords=["TypeError", "renderX"], project_root="E:\\temp", max_hits_per_keyword=5)
  ```
- 拿到候选后，用 `Read` 工具读 `文件:行号` 附近 ±5 行上下文，判断是否是真正的**问题代码**（而非注释或无关引用）。
- **P1-1 二次确认**：若候选较多，把可疑代码片段（3-5 行）作为 `description` 传给 `analyze_image` + `task=verify`，让视觉模型确认「图中报错是否对应这段代码」。
- 报告命中的 **`文件:行号`** 与相关代码片段，帮助用户定位到问题代码。
- 若搜索无命中，照常给结论即可，**不要强行猜测**。

## 3.5 反向验证（拿不准的结论用 verify 核验）

当你基于第一轮结果**推理出某个具体结论**（例如"报错是 TypeError""这个按钮是禁用状态""页面加载失败是因为 404"），而这个结论对后续定位很关键时，用 `task=verify` + `description=你的断言` 让视觉模型回到原图**确认/证伪**，而不是盲信第一次转述：

- 调 `analyze_image`，`path/paths` 同一张图，`task: "verify"`，`description: "断言内容"`。
- **v1.6.0+ 支持显式断言语法**：`description: "assert=按钮是否为红色"` 或 `description: "assert=错误类型是 TypeError"`。bridge 会从 description 里提取 `assert=` 后面的部分作为断言。
- 返回看 `verdict`：`true`=成立 / `false`=被反驳 / `uncertain`=图上看不出来；`evidence` 是图中证据。
- **结构化结果**（v1.6.0+）：返回 `verify.passed`（boolean 或 null）+ `verify.reason`（一句话理由），便于自动化场景（如截图回归测试）直接判断过没过；`verdict=uncertain` 时 `passed=null`。
- `verdict=uncertain` 时，再回到 `task=general` + `focus` 让视觉模型细看相关区域。

## 4. 读取返回的 `control.action`

- `continue` → 呈现后等待用户提供下一张图片继续分析（可询问"是否继续分析下一张"）。
- `stop` → 呈现最终分析内容与 `control.reason`，总结本次分析流程并**结束**，不得再请求更多图片、不得再调用 `analyze_image`。

## 5. 若工具报错提示桥接服务未启动

先等待自动拉起；若仍失败，告知用户运行 `node zhipu-bridge-api.js`（在项目根，确认 8765 端口监听）。
