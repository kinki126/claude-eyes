// ============================================================
// extract-pasted-image.mjs —— 从 Claude 会话转录里提取粘贴的图片
// 背景：VS Code 插件面板粘贴的图以 base64 内嵌在 .claude/projects/<项目>/<会话>.jsonl 里，不落盘。
//       本脚本把最近粘贴的图片解码落盘到 <项目根>\shots\，供视觉桥接分析。
// 用法：
//   node extract-pasted-image.mjs [项目名]            只输出最新一张（默认）
//   node extract-pasted-image.mjs --count 3 [项目名]  输出最近 3 张（每行一个路径，配合多图分析）
//   node extract-pasted-image.mjs --all [项目名]      输出所有
//
// 路径自动推导（不写死用户目录）：
//   - CLAUDE_PROJECTS_DIR 默认 <用户主目录>\.claude\projects（可用环境变量覆盖）
//   - 项目名 = 当前工作目录把 : 与路径分隔符替换成 - （如 E:\temp -> E--temp；可用参数覆盖）
//   - 落盘目录 = 当前工作目录下的 shots（可用 SCREENSHOT_DIR 覆盖）
//
// 输出契约（供 analyze-image skill 调用方解析）：
//   <路径>…                提取到 N 张新图（每行一个路径）→ 用这些路径分析
//   SAME:<路径>            转录里最新的图就是上次已提取过的那张（本次没有新粘贴）
//   （exit 1 + 错误信息）   转录里没有找到任何粘贴图片
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const cwd = process.cwd();

// 参数解析：--count N / --all / [项目名]（跳过 flag 及其值）
const args = process.argv.slice(2);
let count = 1;
let project = null;
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--count') { count = Math.max(1, Number(args[i + 1]) || 1); i++; }
    else if (a === '--all') { count = Infinity; }
    else if (!a.startsWith('--') && project === null) { project = a; }
}
// E:\temp -> E--temp（把 : / \ 统一替换为 -）
const PROJECT = project || cwd.replace(/[:/\\]/g, '-');
const OUT_DIR = process.env.SCREENSHOT_DIR || path.join(cwd, 'shots');
const COUNT = count;

fs.mkdirSync(OUT_DIR, { recursive: true });

// 收集单个会话文件里的所有粘贴图片块
function collectImagesInFile(file) {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
    const out = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        if (!o || !Array.isArray(o?.message?.content)) continue;
        const t = Date.parse(o.timestamp) || 0;
        for (const block of o.message.content) {
            if (block?.type !== 'image' || block?.source?.type !== 'base64' || !block.source.data) continue;
            out.push({
                data: block.source.data,
                media_type: block.source.media_type || 'image/png',
                t, mtime, idx: i
            });
        }
    }
    return out;
}

const projectDir = path.join(PROJECTS_DIR, PROJECT);
if (!fs.existsSync(projectDir)) {
    console.error(`项目转录目录不存在: ${projectDir}`);
    console.error(`（提示：请确认在当前 Claude Code 项目根目录下运行，或用参数指定项目名）`);
    process.exit(1);
}

// 全局收集所有图片 → 按消息时间戳 t 降序（t 相同时 mtime → idx 兜底）→ 去重
let all = [];
for (const name of fs.readdirSync(projectDir)) {
    if (!name.endsWith('.jsonl')) continue;
    all = all.concat(collectImagesInFile(path.join(projectDir, name)));
}
all.sort((a, b) => (b.t - a.t) || (b.mtime - a.mtime) || (b.idx - a.idx));

const seen = new Set();
const uniq = [];
for (const c of all) {
    const key = `${c.t}|${c.idx}|${c.media_type}|${c.data.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
}

if (uniq.length === 0) {
    console.error('未在会话转录里找到粘贴的图片。请确认:1) 确实在插件面板里粘贴了图片;2) 粘贴成功(对话里出现 [Image] 引用)。');
    process.exit(1);
}

const top = uniq.slice(0, COUNT);

// 落盘（同名且字节一致 → 视为已提取过）
function materialize(cand) {
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[cand.media_type] || '.png';
    const ts = (new Date(cand.t || Date.now()).toISOString()).replace(/[^0-9]/g, '').slice(0, 14);
    const bytes = Buffer.from(cand.data, 'base64');
    let outPath = path.join(OUT_DIR, `pasted-${ts}${ext}`);
    let n = 1;
    while (fs.existsSync(outPath)) {
        if (fs.statSync(outPath).size === bytes.length) return { path: outPath, same: true };
        outPath = path.join(OUT_DIR, `pasted-${ts}-${++n}${ext}`);
    }
    fs.writeFileSync(outPath, bytes);
    return { path: outPath, same: false };
}

const results = top.map(materialize);

// 输出：最新一张未提取过 → 输出路径（可能多行）；否则 SAME 表示"没有新粘贴"
if (results[0].same) {
    console.log(`SAME:${results[0].path}`);
    process.exit(0);
}
console.log(results.map((r) => r.path).join('\n'));
