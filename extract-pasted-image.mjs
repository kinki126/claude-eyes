// ============================================================
// extract-pasted-image.mjs —— 从 Claude 会话转录里提取最近粘贴的图片
// 背景：VS Code 插件面板粘贴的图以 base64 内嵌在 .claude/projects/<项目>/<会话>.jsonl 里，不落盘。
//       本脚本把"最新一条粘贴图"解码落盘到 <项目根>\shots\，供视觉桥接分析。
// 用法：node E:\temp\extract-pasted-image.mjs [项目名]   默认由当前工作目录自动推导
//
// 路径自动推导（不写死用户目录）：
//   - CLAUDE_PROJECTS_DIR 默认 <用户主目录>\.claude\projects（可用环境变量覆盖）
//   - 项目名 = 当前工作目录把 : 与路径分隔符替换成 - （如 E:\temp -> E--temp；可用参数覆盖）
//   - 落盘目录 = 当前工作目录下的 shots（可用 SCREENSHOT_DIR 覆盖）
//
// 输出契约（供 analyze-image skill 调用方解析）：
//   <路径>            提取到一张新图（之前未提取过）→ 用该路径分析
//   SAME:<路径>       转录里最新的图就是上次已提取过的那张（本次没有新粘贴）
//   （exit 1 + 错误信息） 转录里没有找到任何粘贴图片
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const cwd = process.cwd();
// E:\temp -> E--temp（把 : / \ 统一替换为 -）
const PROJECT = process.argv[2] || cwd.replace(/[:/\\]/g, '-');
const OUT_DIR = process.env.SCREENSHOT_DIR || path.join(cwd, 'shots');

fs.mkdirSync(OUT_DIR, { recursive: true });

// 在单个会话文件里找"最新"的一张粘贴图片。
// 优先级：消息时间戳 t → 文件 mtime → 行号 idx（后两者仅在 t 相同或缺失时兜底）。
function newestImageInFile(file) {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
    let best = null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        if (!o || !Array.isArray(o?.message?.content)) continue;
        const t = Date.parse(o.timestamp) || 0;
        for (const block of o.message.content) {
            if (block?.type !== 'image' || block?.source?.type !== 'base64' || !block.source.data) continue;
            const isNewer = !best
                || t > best.t
                || (t === best.t && mtime > best.mtime)
                || (t === best.t && mtime === best.mtime && i > best.idx);
            if (isNewer) {
                best = {
                    data: block.source.data,
                    media_type: block.source.media_type || 'image/png',
                    t, mtime, idx: i,
                };
            }
        }
    }
    return best;
}

const projectDir = path.join(PROJECTS_DIR, PROJECT);
if (!fs.existsSync(projectDir)) {
    console.error(`项目转录目录不存在: ${projectDir}`);
    console.error(`（提示：请确认在当前 Claude Code 项目根目录下运行，或用参数指定项目名）`);
    process.exit(1);
}

// 全局扫描所有会话文件，选"消息时间戳最新"的一张粘贴图。
// 注意：不要用"最新写入的会话文件(mtime)"做主排序——正在活跃写入的会话（如本 CLI 会话）
//       文件 mtime 最新，但里面的粘贴图可能很旧（如会话开头的壁纸），会盖过别的会话（如面板）
//       刚贴的新图。用消息时间戳 t 做主排序最稳：旧图时间戳旧，永远抢不到"最新"。
let best = null;
for (const name of fs.readdirSync(projectDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const cand = newestImageInFile(path.join(projectDir, name));
    if (cand && (!best
        || cand.t > best.t
        || (cand.t === best.t && cand.mtime > best.mtime)
        || (cand.t === best.t && cand.mtime === best.mtime && cand.idx > best.idx))) {
        best = cand;
    }
}

if (!best) {
    console.error('未在会话转录里找到粘贴的图片。请确认:1) 确实在插件面板里粘贴了图片;2) 粘贴成功(对话里出现 [Image] 引用)。');
    process.exit(1);
}

const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[best.media_type] || '.png';
const ts = (new Date(best.t || Date.now()).toISOString()).replace(/[^0-9]/g, '').slice(0, 14);
const bytes = Buffer.from(best.data, 'base64');

// 去重：输出文件名 = pasted-<消息时间戳>。同名文件已存在且字节数一致 → 这张图已提取过。
let outPath = path.join(OUT_DIR, `pasted-${ts}${ext}`);
let n = 1;
while (fs.existsSync(outPath)) {
    const same = fs.statSync(outPath).size === bytes.length;
    if (same) {
        console.log(`SAME:${outPath}`);
        process.exit(0);
    }
    // 同一秒内贴了多张不同的图 → 加后缀避开
    outPath = path.join(OUT_DIR, `pasted-${ts}-${++n}${ext}`);
}
fs.writeFileSync(outPath, bytes);
console.log(outPath);
