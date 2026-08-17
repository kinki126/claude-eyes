# 👁️ Claude Eyes

> Give **Claude Code** eyes — analyze local screenshots through an MCP tool + vision LLM bridge, with automatic **continue / stop** control.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D%2018-brightgreen.svg)](package.json)
[![CI](https://github.com/kinki126/claude-eyes/actions/workflows/ci.yml/badge.svg)](https://github.com/kinki126/claude-eyes/actions/workflows/ci.yml)

<!-- 若你的 GitHub 用户名不是 kinki126，请把上面 badge 链接里的 kinki126/claude-eyes 改成你的用户名/仓库名 -->

**English** · [中文](README.zh-CN.md)

---

When your Claude Code runs on a non-vision backend (e.g. DeepSeek), it can't see images. **Claude Eyes** fixes that: you paste a screenshot, take a screenshot, or give a path — Claude calls the `analyze_image` MCP tool, a vision LLM analyzes it, and returns structured results while **automatically deciding** whether to continue (wait for the next image) or stop.

## Features

- 🖼️ **Analyze images via function calling** — Claude natively calls the `analyze_image` MCP tool; no model swap needed
- 🔁 **Automatic continue/stop** — the vision model decides per image whether the flow continues or ends
- 📋 **Four ways to feed an image** — VS Code panel paste (Trae-style) / screenshot auto-save / direct path / **base64 upload (remote MCP)**
- 🔌 **Provider-agnostic** — depends only on OpenAI-compatible `chat/completions` + vision (`image_url` base64); switch providers via config (Zhipu / OpenAI / Qwen-VL / DeepSeek-VL / Ollama / vLLM)
- ⚙️ **Ops-ready** — dedup cache + image-byte cache, per-user rate limiting, usage logs, health check, multi-provider failover with **retry + circuit breaker**, auto-spawned bridge
- 📊 **Observability** — `/metrics` endpoint exports QPS / latency p50/p95/p99 / error rate / by-task / by-provider / by-user (10-min rolling window); `X-Request-Id` traces every request across MCP → bridge → LLM logs
- 🧠 **Smart task routing** — bridge scans `description` / `focus` keywords and auto-routes `general` → `error` / `diff` / `ocr` / `ui` (user-specified `task` always wins)
- 🗂️ **Analysis history** — every successful analysis is appended to `.claude-eyes/history.jsonl` (ts / md5 / task / analysis / regions / etc.); grep it to revisit "the TypeError screenshot from yesterday"
- 🧩 **Portable** — all paths derived from the current directory + home directory; one-command `setup.mjs`; move the whole folder anywhere
- 🔍 **Multi-turn focus + coordinate localization + crop-zoom** — `focus` zooms the vision model into a region; `regions` returns normalized bboxes; **`crop_bbox` crops & enlarges the region for the next turn** (sharp-based, min edge 800px) for high-precision follow-up
- 🖼️ **Adaptive image processing** — photos → WebP q=80 (80%+ smaller); UI/text → PNG lossless; long screenshots (aspect ratio > 3) auto-sliced into 2-5 overlapping segments; `task=ocr` runs grayscale + histogram equalization + binarization for sharper text recognition
- 🧾 **Verbatim + verification** — `verbatim` transcribes error stacks/codes verbatim (no lossy summarization); `task=verify` sends a conclusion back to the vision model for confirmation (`verdict: true/false/uncertain`)
- 📦 **JSON mode by default** — `response_format: { type: 'json_object' }` enabled for supported providers (auto-disabled for Ollama); 5-layer parser fallback still in place for unsupported/edge cases
- 🔐 **Remote-ready** — `POST /analyze` accepts base64 images (64MB body limit); `server-http.js` auth uses `crypto.timingSafeEqual` to prevent timing attacks

## Architecture

```
Claude Code ──function call──▶ mcp-image-analyzer (MCP) ──HTTP──▶ bridge (8765) ──▶ Vision LLM
                                      ▲                                    │
                              auto-spawn on demand                 unified { analysis, control }
```

- `zhipu-bridge-api.js` + `vision-client.js` — bridge service & provider abstraction
- `mcp-image-analyzer/` — MCP server (`index.js` local stdio, `server-http.js` remote HTTP)
- `setup.mjs` — one-command install/config wizard

## Quickstart

Prereqs: Node ≥ 18, Claude Code.

```bash
# 1. Run the wizard (enter your own vision-model API key)
node setup.mjs   # default = user-level install (works in any project); add --project-level for folder-only
# recommended: install to a fixed dir so the unzip folder can be deleted -> node setup.mjs --install
# switch vision provider: node setup.mjs --provider qwen|zhipu|doubao|openai|ollama

# 2. Restart Claude Code in the project root; /mcp should show image-analyzer ✓

# 3. Start analyzing
```

See [`QUICKSTART.md`](QUICKSTART.md) for details.

**Upgrade**: new/fixed-install users → `node setup.mjs --install` (or `--update`); old v1.00 in-place users → unzip the new version and run `node setup.mjs --upgrade` (auto uninstall old + fresh install). See the **Upgrade** section in [`QUICKSTART.md`](QUICKSTART.md).

## Usage

| Way | Action |
|---|---|
| 🖼️ **Panel paste** (Trae-style) | `Ctrl+V` an image in the VS Code Claude panel, press Enter → auto-analyzed |
| 📸 **Screenshot** | `Win+Shift+S` (enable Snipping Tool auto-save) → say "analyze the latest screenshot" |
| 📁 **Direct path** | say "analyze `E:\xxx\shot.png`" |

More scenarios: [`docs/USAGE.md`](docs/USAGE.md)

## Configuration

Priority: **env vars > `vision-config.json` > defaults**. Provider switching, multi-provider failover, cache/rate-limit/logs: see [`docs/CONFIG.md`](docs/CONFIG.md).

## Documentation

- [`QUICKSTART.md`](QUICKSTART.md) — 5-minute setup for new users
- [`docs/CONFIG.md`](docs/CONFIG.md) — full configuration reference
- [`docs/USAGE.md`](docs/USAGE.md) — usage by scenario
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — company deployment (remote MCP / local bundle)

## Project layout

```
├── setup.mjs                     # one-command install/config wizard
├── zhipu-bridge-api.js           # bridge service (port 8765)
├── vision-client.js              # vision provider abstraction + failover
├── vision-config.example.json    # config template (empty key)
├── latest-shot.mjs               # find latest screenshot
├── extract-pasted-image.mjs      # extract panel-pasted image from transcript
├── save-shot.bat                 # save clipboard screenshot (fallback)
├── start-bridge.bat / start-remote-mcp.bat
├── mcp-image-analyzer/           # MCP server
│   ├── index.js                  # local stdio entry
│   ├── server-http.js            # remote HTTP entry
│   ├── analyze-tool.js           # shared tool logic (incl. auto-spawn)
│   └── smoke/                    # manual smoke scripts
├── test/                         # automated tests (npm test)
└── .claude/skills/analyze-image/ # Claude-side skill (auto-trigger + path resolution)
```

## Development & Testing

```bash
npm test             # offline tests: parser unit tests + bridge force_action smoke (no API key needed)
npm run smoke        # local MCP smoke (needs running bridge + real key)
npm run smoke:remote # remote HTTP MCP smoke
```

## License

[MIT](LICENSE)

## Notes

- **Keys**: each user registers their own vision-model account; `vision-config.json` is git-ignored — never commit it.
- **Cost**: every analysis is a paid API call.
- **Privacy**: screenshots are sent to the configured vision provider (cloud by default). For sensitive content, configure a local model (e.g. Ollama).
