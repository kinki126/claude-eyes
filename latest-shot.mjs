// ============================================================
// latest-shot.mjs —— 返回最近一张截图的绝对路径
// 用法：node latest-shot.mjs [目录]  默认扫描 <项目根>\shots 与系统"图片\屏幕截图"
// 路径自动推导（不写死用户目录）：
//   - <项目根>\shots                 = 当前工作目录下的 shots（Claude 在项目根运行）
//   - 系统"图片\屏幕截图"             = <用户主目录>\Pictures\Screenshots
// 可用 SCREENSHOT_DIR 环境变量覆盖扫描目录。
// 供 analyze-image skill 使用："分析最新一张截图"
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cwd = process.cwd();
const SCAN_DIRS = process.env.SCREENSHOT_DIR
    ? [process.env.SCREENSHOT_DIR]
    : [
        path.join(cwd, 'shots'),
        path.join(os.homedir(), 'Pictures', 'Screenshots')
    ];
const dirs = process.argv[2] ? [path.resolve(process.argv[2])] : SCAN_DIRS;
const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

let newest = null;
for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
        const ext = path.extname(name).toLowerCase();
        if (!EXTS.has(ext)) continue;
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            if (!newest || st.mtimeMs > newest.mtimeMs) {
                newest = { full, mtimeMs: st.mtimeMs };
            }
        } catch { /* 忽略单个文件读取失败 */ }
    }
}

if (newest) {
    console.log(newest.full);
} else {
    console.error(`未找到图片文件，请先截图保存到以下任一目录:\n${dirs.join('\n')}`);
    process.exit(1);
}
