# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
