// ============================================================
// session-start-hook.cjs —— Claude Code SessionStart hook
// 职责：确保视觉桥(127.0.0.1:8765)在线，消除 analyze_image 冷启动探活延迟。
// 不阻塞 Claude 启动（失败只记日志，启动照常）。
//
// 路径规则（无硬编码）：
//   - BRIDGE_SCRIPT_PATH 优先用环境变量，否则取 <hook 所在目录的上一级>/zhipu-bridge-api.js
//   - LOG_DIR 优先用环境变量，否则取 <hook 所在目录的上一级>/logs
//   - hook 所在目录 = __dirname（即 mcp-image-analyzer/），项目根 = 上一级
// ============================================================
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_URL = process.env.BRIDGE_BASE_URL || 'http://127.0.0.1:8765';
const BRIDGE_SCRIPT = process.env.BRIDGE_SCRIPT_PATH
    ? path.resolve(PROJECT_ROOT, process.env.BRIDGE_SCRIPT_PATH)
    : path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const LOG_DIR = process.env.CLAUDE_EYES_LOG_DIR || path.join(PROJECT_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'mcp-heal-hook.log');

function log(msg) {
    const line = `${new Date().toISOString()} [session-start-hook] ${msg}\n`;
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line); } catch {}
}

function checkHealth(timeoutMs) {
    return new Promise((resolve) => {
        const req = http.get(new URL('/health', BRIDGE_URL), { timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

(async () => {
    if (await checkHealth(2000)) { log('视觉桥已在运行'); process.exit(0); }
    log('视觉桥未运行，尝试拉起: ' + BRIDGE_SCRIPT);
    try {
        const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
        });
        child.unref();
    } catch (err) {
        log('拉起失败: ' + (err && err.message || err));
        process.exit(0);
    }
    // 简短确认（最多 ~6s），失败也不阻塞 Claude 启动
    for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await checkHealth(400)) { log('视觉桥已就绪'); process.exit(0); }
    }
    log('视觉桥拉起后未确认（不阻塞启动）');
    process.exit(0);
})();
