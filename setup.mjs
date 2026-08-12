#!/usr/bin/env node
// ============================================================
// setup.mjs —— 图像分析系统 一键安装 / 配置向导（内部版）
//
// 用法：
//   node setup.mjs                交互式（有终端时）
//   node setup.mjs --yes          非交互（跳过提问，用环境变量）
//   环境变量：VISION_API_KEY      视觉模型密钥（--yes 或非 TTY 时用）
//            VISION_BASE_URL/VISION_MODEL/VISION_CHAT_PATH   （可选，覆盖提供商）
//            MCP_USER             用户标识（默认取系统用户名）
//
// 做什么：
//   1) 检查 Node 版本、必备文件
//   2) 配置 vision-config.json（密钥，交互提问或读 VISION_API_KEY）
//   3) 两处 npm install（桥接依赖、MCP 依赖）
//   4) 生成 .mcp.json（绝对路径，供 Claude Code 加载 MCP）
//   5) 自检：启动桥接 → 探测 /health → 关掉
//   6) 打印下一步
// 全部路径由本脚本所在目录推导，不写死用户路径，可整体搬迁。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = __dirname;                       // 项目根（本文件所在目录）
const MCP_DIR = path.join(BASE_DIR, 'mcp-image-analyzer');
const BRIDGE_SCRIPT = path.join(BASE_DIR, 'zhipu-bridge-api.js');
const NON_INTERACTIVE = process.argv.includes('--yes') || !process.stdin.isTTY;

const c = {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const step = (s) => console.log(`\n${c.cyan('==>')} ${s}`);
const ok = (s) => console.log(`  ${c.green('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.yellow('!')} ${s}`);
const fail = (s) => console.log(`  ${c.red('✗')} ${s}`);

function ask(question) {
    if (NON_INTERACTIVE) return null;
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
    });
}

function verifyNodeVersion() {
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 14) { fail(`Node 版本过低: ${process.version}（桥接需 ≥14，MCP 需 ≥18）`); process.exit(1); }
    ok(`Node ${process.version}（桥接≥14，MCP≥18${major < 18 ? `，当前 MCP 可能需升级 ${c.yellow('node>=18 建议')}` : ''}）`);
    return major;
}

async function ensureVisionConfig() {
    const RESET_KEY = process.argv.includes('--reset-key');
    const cfgPath = path.join(BASE_DIR, 'vision-config.json');
    if (fs.existsSync(cfgPath) && !RESET_KEY) {
        try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (cfg.api_key) { ok(`vision-config.json 已存在（模型 ${cfg.model || '?'}）`); return cfg; }
        } catch { /* 重新生成 */ }
    }
    if (RESET_KEY) warn('--reset-key：将重新生成 vision-config.json（覆盖原密钥）');

    const base_url = process.env.VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    const model = process.env.VISION_MODEL || 'glm-4.6v';
    const chat_path = process.env.VISION_CHAT_PATH || '/chat/completions';

    let api_key = process.env.VISION_API_KEY || '';
    if (!api_key && !NON_INTERACTIVE) {
        api_key = await ask(`请输入视觉模型 API Key（智谱，留空跳过）: `) || '';
    }

    const cfg = { base_url, api_key, model, chat_path, providers: [] };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    if (api_key) ok(`已写入 vision-config.json（模型 ${model}）`);
    else warn('vision-config.json 已生成但 api_key 为空——请在运行前填入，否则分析会失败。');
    return cfg;
}

function npmInstall(cwdDir, label) {
    step(`安装依赖: ${label}`);
    if (!fs.existsSync(path.join(cwdDir, 'package.json'))) { warn(`缺少 package.json: ${cwdDir}（跳过）`); return false; }
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], { cwd: cwdDir, stdio: 'inherit' });
    if (r.status !== 0) { fail(`npm install 失败: ${label}`); process.exit(1); }
    ok(`依赖就绪: ${label}`);
    return true;
}

function writeMcpJson() {
    const mcpUser = process.env.MCP_USER || os.userInfo().username;
    const mcpJson = {
        mcpServers: {
            'image-analyzer': {
                command: 'node',
                args: [path.join(MCP_DIR, 'index.js')],
                cwd: MCP_DIR,
                env: {
                    BRIDGE_BASE_URL: 'http://127.0.0.1:8765',
                    BRIDGE_SCRIPT_PATH: BRIDGE_SCRIPT,
                    AUTO_SPAWN_BRIDGE: '1',
                    MCP_USER: mcpUser
                }
            }
        }
    };
    const out = path.join(BASE_DIR, '.mcp.json');
    fs.writeFileSync(out, JSON.stringify(mcpJson, null, 2) + '\n');
    ok(`已生成 .mcp.json（MCP_USER=${mcpUser}）`);
    return out;
}

function healthCheck() {
    return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8765/health', { timeout: 1500 }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => { try { const j = JSON.parse(d); resolve(j.ok); } catch { resolve(false); } });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function selfCheckBridge() {
    step('自检: 桥接服务');
    if (!fs.existsSync(BRIDGE_SCRIPT)) { fail(`桥接脚本不存在: ${BRIDGE_SCRIPT}`); return false; }
    const child = spawn(process.execPath, [BRIDGE_SCRIPT], { cwd: BASE_DIR, stdio: 'ignore', windowsHide: true });
    child.unref();
    let okNow = false;
    for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (await healthCheck()) { okNow = true; break; }
    }
    if (okNow) ok('/health 通过（端口 8765）');
    else fail('桥接未能启动或 /health 无响应——请检查依赖与 vision-config.json');
    // 关掉自检启动的桥接
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    return okNow;
}

console.log(c.cyan(`\n图像分析系统 一键安装向导\n${'='.repeat(36)}`));
ok(`安装目录: ${BASE_DIR}`);
const nodeMajor = verifyNodeVersion();

const cfg = await ensureVisionConfig();

npmInstall(BASE_DIR, '桥接依赖');
npmInstall(MCP_DIR, 'MCP 依赖');

const mcpJsonPath = writeMcpJson();
await selfCheckBridge();

// 汇总
step('完成');
ok(`配置文件: ${path.join(BASE_DIR, 'vision-config.json')}${cfg.api_key ? '' : c.red('（api_key 为空！）')}`);
ok(`MCP 注册: ${mcpJsonPath}`);
ok(`桥接脚本: ${BRIDGE_SCRIPT}`);
console.log(`
${c.green('下一步')}
  1. 确保桥接在运行: node zhipu-bridge-api.js（或在配置后首次调用时自动拉起）
  2. 重启 Claude Code（${c.cyan('Ctrl+C 退出后重新启动')}），使 .mcp.json 生效
  3. /mcp 确认 image-analyzer ✓ 后即可使用
  4. 三种用法:
     - 面板粘贴: Ctrl+V 图片 → 回车（自动分析）
     - 截图: Win+Shift+S（开自动保存）→ 说"分析最新一张截图"
     - 路径: 说"分析 <图片绝对路径>"
`);
