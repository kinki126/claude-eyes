#!/usr/bin/env node
// ============================================================
// setup.mjs —— 图像分析系统 一键安装 / 配置向导
//
// 用法：
//   node setup.mjs                用户级安装（默认）：任何 Claude 项目都能用
//   node setup.mjs --project-level  项目级安装：只在当前文件夹生效
//   node setup.mjs --user-level   显式指定用户级（等价默认）
//   node setup.mjs --install      安装到固定目录（默认 ~/.claude/claude-eyes），解压目录可删
//   node setup.mjs --install --dir <路径>   指定安装目录（或 INSTALL_DIR 环境变量）
//   node setup.mjs --update       更新（下载新 zip 解压到当前文件夹后跑本命令，等价重装）
//   node setup.mjs --upgrade      一键升级（先卸载旧版注册，再安装全新版本；老 v1.00 就地用户用这个）
//   node setup.mjs --uninstall    卸载（移除用户级 MCP/skill + 删固定安装目录）
//   node setup.mjs --yes          非交互（跳过提问，用环境变量）
//   环境变量：VISION_API_KEY      视觉模型密钥（--yes 或非 TTY 时用）
//            VISION_BASE_URL/VISION_MODEL/VISION_CHAT_PATH   （可选，覆盖提供商）
//            MCP_USER             用户标识（默认取系统用户名）
//
// 做什么：
//   1) 检查 Node 版本、必备文件
//   2) 配置 vision-config.json（密钥，交互提问或读 VISION_API_KEY）
//   3) 两处 npm install（桥接依赖、MCP 依赖）
//   4) 项目级：生成 .mcp.json；用户级：注册 MCP 到 -s user + 安装 skill 到 ~/.claude/skills
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
// 默认用户级安装；显式 --project-level 切回仅当前文件夹生效
const PROJECT_LEVEL = process.argv.includes('--project-level');
const USER_LEVEL = !PROJECT_LEVEL;
const INSTALL = process.argv.includes('--install');
const UPDATE = process.argv.includes('--update');
const UPGRADE = process.argv.includes('--upgrade');
const UNINSTALL = process.argv.includes('--uninstall');

// 当前版本（用于版本跟踪 installed-version）
let CURRENT_VERSION = '0.0.0';
try {
    CURRENT_VERSION = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8')).version || '0.0.0';
} catch { /* 忽略 */ }

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
    // Windows 上直接 spawn npm.cmd 会 EINVAL，须经 shell 执行（shell:true；参数固定安全）
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'],
        { cwd: cwdDir, stdio: 'inherit', shell: process.platform === 'win32' });
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

// ---------- 用户级安装（--user-level） ----------
function runClaude(args, capture = false) {
    // claude 可能是 .exe 或 .cmd；Windows 上一律经 shell 执行最稳（参数固定安全）
    const opts = { shell: process.platform === 'win32' };
    if (capture) opts.stdio = 'pipe';
    else opts.stdio = 'inherit';
    return spawnSync('claude', args, opts);
}

function installUserLevelMcp() {
    step('用户级安装: 注册 MCP（对所有 Claude 项目生效）');
    const mcpUser = process.env.MCP_USER || os.userInfo().username;
    const mcpIndex = path.join(MCP_DIR, 'index.js');
    const bridgePosix = BRIDGE_SCRIPT.replace(/\\/g, '/');
    // 先移除旧的同名注册，再添加——claude mcp add 对"已存在的同名 server"不会更新路径，
    // 不先删会导致 --install 后 MCP 仍指向旧位置。
    runClaude(['mcp', 'remove', 'image-analyzer', '-s', 'user']);
    const r = runClaude([
        'mcp', 'add', 'image-analyzer', '-s', 'user',
        '-e', 'BRIDGE_BASE_URL=http://127.0.0.1:8765',
        '-e', `BRIDGE_SCRIPT_PATH=${bridgePosix}`,
        '-e', 'AUTO_SPAWN_BRIDGE=1',
        '-e', `MCP_USER=${mcpUser}`,
        '--', 'node', mcpIndex
    ], true);
    const out = `${r.stdout || ''} ${r.stderr || ''}`;
    // 幂等：已存在不算失败
    if (r.status !== 0 && !/already exists/i.test(out)) {
        warn('claude mcp add 失败——请确认 claude 命令可用，或手动按 docs/USAGE.md 操作');
        return false;
    }
    ok('MCP 已注册到用户级（先删后加，确保指向当前目录）');
    return true;
}

function installUserLevelSkill() {
    step('用户级安装: 安装 analyze-image skill');
    const src = path.join(BASE_DIR, '.claude', 'skills', 'analyze-image', 'SKILL.md');
    if (!fs.existsSync(src)) { warn(`项目 skill 不存在: ${src}（跳过）`); return false; }
    const base = BASE_DIR.replace(/\\/g, '/');
    let s = fs.readFileSync(src, 'utf8');
    // 相对命令改成绝对路径；顶部提示行改为"任意项目可用"
    s = s
        .replace(/> 提示：本 skill 里所有脚本命令都[^\n]*/,
            `> 提示：本 skill 为**用户级**安装，任意 Claude 项目可用；辅助脚本在 <安装目录>（${base}），图片落盘到当前项目 shots\\`)
        .replace(/node extract-pasted-image\.mjs/g, `node ${base}/extract-pasted-image.mjs`)
        .replace(/node latest-shot\.mjs/g, `node ${base}/latest-shot.mjs`)
        .replace(/node zhipu-bridge-api\.js/g, `node ${base}/zhipu-bridge-api.js`);
    const outDir = path.join(os.homedir(), '.claude', 'skills', 'analyze-image');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, 'SKILL.md');
    fs.writeFileSync(out, s);
    ok(`已安装用户级 skill: ${out}`);
    return true;
}

// ---------- 安装到固定目录（--install） ----------
function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function resolveInstallDir() {
    const given = argValue('--dir') || process.env.INSTALL_DIR || '';
    return given ? path.resolve(given) : path.join(os.homedir(), '.claude', 'claude-eyes');
}

// 手工递归复制（不用 fs.cpSync：它在 Windows 上复制含 .git 的目录树会原生崩溃 exit 127）
function copyTree(src, dst, exclusions) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const ss = path.join(src, name);
        const rel = path.relative(src, ss);
        if (rel.split(path.sep).some((p) => exclusions.has(p))) continue;
        const dd = path.join(dst, name);
        const st = fs.statSync(ss);
        if (st.isDirectory()) copyTree(ss, dd, exclusions);
        else fs.copyFileSync(ss, dd);
    }
}

function installToPermanent() {
    const installDir = resolveInstallDir();
    if (path.resolve(installDir) === path.resolve(BASE_DIR)) {
        warn('安装目录就是当前目录——无需复制，直接原地做用户级安装');
        return; // 走常规流程
    }
    // 防护：安装目录不能在项目文件夹内部（cpSync 会拒绝复制到自身子目录）
    const rel = path.relative(BASE_DIR, installDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        fail(`安装目录不能在项目文件夹内部，请换一个位置（如 ~/.claude/claude-eyes）: ${installDir}`);
        process.exit(1);
    }
    step(`安装到固定目录: ${installDir}`);
    fs.mkdirSync(installDir, { recursive: true });

    // 版本跟踪：读取旧的 installed-version
    let oldVer = '';
    try { oldVer = fs.readFileSync(path.join(installDir, 'installed-version'), 'utf8').trim(); } catch { /* 无 */ }

    // 更新场景：备份旧配置（密钥兜底，防重装出错丢失）
    const cfgInInstall = path.join(installDir, 'vision-config.json');
    try {
        if (fs.existsSync(cfgInInstall)) fs.copyFileSync(cfgInInstall, cfgInInstall + '.bak');
    } catch { /* ignore */ }

    // 清掉旧内容，但保留"带 key 的 vision-config.json"
    let keepKey = false;
    try {
        const c = JSON.parse(fs.readFileSync(cfgInInstall, 'utf8'));
        keepKey = !!(c.api_key);
    } catch { keepKey = false; }
    for (const entry of fs.readdirSync(installDir)) {
        if ((entry === 'vision-config.json' && keepKey) || entry === 'vision-config.json.bak') continue;
        fs.rmSync(path.join(installDir, entry), { recursive: true, force: true });
    }

    // 复制源码（排除依赖/运行垃圾/项目级注册/密钥）
    // 用 copyTree 而非 fs.cpSync（Windows 上 cpSync 复制含 .git 的目录树会原生崩溃 exit 127）
    const EXCLUDE = new Set(['node_modules', 'shots', 'logs', '.git', '.mcp.json', 'vision-config.json']);
    copyTree(BASE_DIR, installDir, EXCLUDE);
    // 密钥：安装目录没有带 key 的，就从源带过去
    if (!keepKey && fs.existsSync(path.join(BASE_DIR, 'vision-config.json'))) {
        fs.copyFileSync(path.join(BASE_DIR, 'vision-config.json'), cfgInInstall);
        ok('已携带密钥配置到安装目录');
    }
    ok(`文件已复制: ${BASE_DIR} → ${installDir}`);

    // 在安装目录里跑标准用户级 setup（npm install / 注册 MCP / 装 skill / 自检）
    step('在安装目录中运行用户级 setup...');
    const child = spawnSync(process.execPath, [path.join(installDir, 'setup.mjs'), '--user-level'], {
        cwd: installDir,
        stdio: 'inherit',
        env: { ...process.env }
    });
    if (child.status !== 0) {
        fail(`安装目录中的 setup 执行失败（exit ${child.status}）`);
        process.exit(1);
    }

    // 写版本跟踪
    fs.writeFileSync(path.join(installDir, 'installed-version'), CURRENT_VERSION);

    console.log(`\n${c.green('✅ 安装完成')}`);
    console.log(`  版本: ${oldVer ? `${c.yellow(`v${oldVer}`)} → ` : ''}${c.cyan(`v${CURRENT_VERSION}`)}`);
    console.log(`  固定安装目录: ${installDir}`);
    console.log(`  用户级 MCP/skill 已指向它。现在可以 ${c.yellow('删除原始解压目录')} 了。`);
    console.log(`  更新方式: 重新下载 zip → 解压 → 再跑 node setup.mjs --update`);
    return true;
}

function uninstallAll() {
    step('卸载: 移除用户级注册与固定安装');
    // 1) 移除用户级 MCP 注册
    runClaude(['mcp', 'remove', 'image-analyzer', '-s', 'user']);
    ok('已移除用户级 MCP 注册');
    // 2) 删用户级 skill
    const skillDir = path.join(os.homedir(), '.claude', 'skills', 'analyze-image');
    fs.rmSync(skillDir, { recursive: true, force: true });
    ok(`已删除用户级 skill: ${skillDir}`);
    // 3) 删固定安装目录（仅当不是当前工作目录，防误删）
    const installDir = resolveInstallDir();
    if (fs.existsSync(installDir) && path.resolve(installDir) !== path.resolve(BASE_DIR)) {
        fs.rmSync(installDir, { recursive: true, force: true });
        ok(`已删除固定安装目录: ${installDir}`);
    } else if (path.resolve(installDir) === path.resolve(BASE_DIR)) {
        warn('安装目录就是当前目录——未删除当前文件夹');
    } else {
        warn(`未发现固定安装目录: ${installDir}`);
    }
    console.log(`\n${c.green('✅ 已卸载')}`);
    console.log('  如需删除当前项目文件夹,请手动删除。');
    return true;
}

// ---------- 一键升级（--upgrade）：先卸旧版，再装全新版本 ----------
function upgradeAll() {
    step('升级: 先卸载旧版，再安装全新版本');
    const installDir = resolveInstallDir();

    // 1) 旧版本检测
    let oldVer = '';
    try { oldVer = fs.readFileSync(path.join(installDir, 'installed-version'), 'utf8').trim(); } catch { /* 无 */ }
    if (oldVer) ok(`检测到旧版本: v${oldVer}`);
    else warn('未检测到版本记录（可能是 v1.00 就地安装，或首次升级）');

    // 2) 卸载旧用户级注册 + skill（清掉老就地安装指向旧文件夹的注册）
    runClaude(['mcp', 'remove', 'image-analyzer', '-s', 'user']);
    const skillDir = path.join(os.homedir(), '.claude', 'skills', 'analyze-image');
    fs.rmSync(skillDir, { recursive: true, force: true });
    ok('已卸载旧版用户级注册与 skill');

    // 3) 备份旧配置（若固定安装目录存在）
    const cfgPath = path.join(installDir, 'vision-config.json');
    try {
        if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, cfgPath + '.bak');
    } catch { /* ignore */ }

    // 4) 全新安装到固定目录
    installToPermanent();

    console.log(`\n${c.green('✅ 升级完成')}: v${oldVer || '?'} → v${CURRENT_VERSION}`);
    console.log(`  旧解压文件夹现在可以删除（如需保留旧密钥，见 vision-config.json.bak）。`);
    return true;
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

console.log(c.cyan(`\n图像分析系统 一键安装向导${INSTALL ? '（安装到固定目录）' : (USER_LEVEL ? '（用户级·默认）' : '（项目级）')}\n${'='.repeat(36)}`));
ok(`当前目录: ${BASE_DIR}`);
verifyNodeVersion();

if (UPGRADE) {
    upgradeAll();
    process.exit(0);
}
if (UNINSTALL) {
    uninstallAll();
    process.exit(0);
}
if (INSTALL || UPDATE) {
    installToPermanent();
    process.exit(0);
}

const cfg = await ensureVisionConfig();

npmInstall(BASE_DIR, '桥接依赖');
npmInstall(MCP_DIR, 'MCP 依赖');

let mcpNote;
if (USER_LEVEL) {
    installUserLevelMcp();
    installUserLevelSkill();
    mcpNote = '已注册到用户级（所有项目可用），未生成项目级 .mcp.json';
} else {
    mcpNote = writeMcpJson();
}
await selfCheckBridge();

// 汇总
step('完成');
ok(`配置文件: ${path.join(BASE_DIR, 'vision-config.json')}${cfg.api_key ? '' : c.red('（api_key 为空！）')}`);
ok(`MCP 注册: ${mcpNote}`);
ok(`桥接脚本: ${BRIDGE_SCRIPT}`);
console.log(`
${c.green('下一步')}
  1. 确保桥接在运行: node zhipu-bridge-api.js（或在配置后首次调用时自动拉起）
  2. 重启 Claude Code（${c.cyan('Ctrl+C 退出后重新启动')}）
     - ${USER_LEVEL
        ? `本次为用户级安装: 在 ${c.cyan('任意项目')} 启动，/mcp 确认 image-analyzer ✓`
        : `本次为项目级安装: 在 ${c.cyan('当前文件夹')} 启动，/mcp 确认 image-analyzer ✓`}
  3. 三种用法:
     - 面板粘贴: Ctrl+V 图片 → 回车（自动分析）
     - 截图: Win+Shift+S（开自动保存）→ 说"分析最新一张截图"
     - 路径: 说"分析 <图片绝对路径>"
`);
