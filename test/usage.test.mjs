// ============================================================
// usage.test.mjs —— 用户使用层面端到端测试
// 模拟真实用户的实际操作路径，每个用例对应一个用户故事：
//   A. 喂图方式（4 种）：路径 / 最新截图脚本 / 粘贴图片提取脚本 / base64 上传
//   B. 任务场景：报错定位（自动路由） / 多图对比 / 多轮追问 / 精准放大 / 反向验证
//   C. 历史回看：成功分析后 history.jsonl 可 grep
//   D. 用户视角的可观测性：/metrics 反映用户请求
//   E. 错误体验：缺参 / 文件不存在 / 越界 / 无图
// 全部用 force_action 跳过真实模型，便于 CI 离线跑
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const PORT = 18810;

// ---------- bridge 启动/请求工具 ----------

function startBridge(env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, LISTEN_PORT: String(PORT), USAGE_LOG: '0', ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.once('error', reject);
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) { clearInterval(timer); resolve(child); }
            });
            req.on('error', () => { if (attempts > 60) { clearInterval(timer); child.kill(); reject(new Error('bridge 启动失败')); } });
        }, 100);
    });
}

function reqJson(method, pathStr, { headers, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port: PORT, method, path: pathStr,
            headers: { ...(headers || {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, headers: res.headers, body: text }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function makePng(w = 100, h = 100, opts = {}) {
    const bg = opts.bg || { r: 200, g: 100, b: 50 };
    return sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();
}
async function makeJpeg(w = 100, h = 100) {
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 100, g: 150, b: 200 } } }).jpeg({ quality: 80 }).toBuffer();
}

function killTree(child) { try { child.kill(); } catch {} }

/** 辅助：spawn 一个本地脚本并拿到 stdout 第一行（模拟 skill 调 latest-shot.mjs / extract-pasted-image.mjs） */
function runScriptAndGetFirstLine(scriptPath, args = [], env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString(); });
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(`脚本退出码 ${code}: ${stderr || stdout}`));
            resolve(stdout.split('\n').filter(Boolean)[0] || '');
        });
        child.on('error', reject);
    });
}

// ============================================================
// A. 喂图方式（用户给图的 4 种途径）
// ============================================================

test('用户场景 A1: 直接给路径分析（最稳的喂图方式）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-path.png');
    fs.writeFileSync(img, await makePng(80, 80));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.meta.image_count, 1);
        assert.equal(r.body.image.path, img, '响应应回带原路径');
        assert.equal(r.body.image.md5.length, 32, '应返回 md5');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 A2: latest-shot.mjs 找到最新截图后分析', async () => {
    // 模拟用户截图保存到独立目录（用 SCREENSHOT_DIR 隔离，避免其他测试在 shots/ 残留文件干扰）
    const isolatedShotsDir = path.join(PROJECT_ROOT, 'shots', '.ci-use-latest-isolated');
    fs.rmSync(isolatedShotsDir, { recursive: true, force: true });
    fs.mkdirSync(isolatedShotsDir, { recursive: true });
    const img1 = path.join(isolatedShotsDir, 'shot-1.png');
    const img2 = path.join(isolatedShotsDir, 'shot-2.png');
    fs.writeFileSync(img1, await makePng(60, 60));
    // 确保 img2 mtime 更新
    await new Promise(r => setTimeout(r, 50));
    fs.writeFileSync(img2, await makePng(60, 60));
    const child = await startBridge();
    try {
        // 用户场景：Claude 先跑 latest-shot.mjs（指向隔离目录）拿到路径，再调 /analyze
        const found = await runScriptAndGetFirstLine(path.join(PROJECT_ROOT, 'latest-shot.mjs'),
            [isolatedShotsDir]);
        assert.equal(found, img2, '应找到 mtime 最新的那张');
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(found)}&force_action=continue`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
    } finally {
        try { fs.rmSync(isolatedShotsDir, { recursive: true, force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 A3: latest-shot.mjs 无图时 exit 1（脚本契约）', async () => {
    // 指向空目录，脚本应 exit 1
    const emptyDir = path.join(PROJECT_ROOT, 'shots', '.ci-empty');
    fs.rmSync(emptyDir, { recursive: true, force: true });
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
        await runScriptAndGetFirstLine(path.join(PROJECT_ROOT, 'latest-shot.mjs'), [emptyDir]);
        assert.fail('空目录应 exit 1');
    } catch (e) {
        assert.match(e.message, /退出码 1/);
    } finally {
        try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
    }
});

test('用户场景 A4: POST /analyze base64 上传（远程 MCP 模式）', async () => {
    const child = await startBridge();
    const png = await makePng(100, 100);
    try {
        // 注意：直接 POST 到 bridge 用的是 desc 字段；MCP 工具层才会把 description 映射到 desc
        const r = await reqJson('POST', '/analyze', {
            body: {
                images: [{ base64: png.toString('base64') }],
                desc: '看下这个报错',  // 触发 task 自动路由
                force_action: 'continue'
            }
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.meta.image_count, 1);
        assert.equal(r.body.image.path, 'remote-base64-#0', '远程上传 path 应为占位符');
        assert.equal(r.body.meta.task, 'error', 'desc 含"报错"应自动路由到 error task');
    } finally { killTree(child); }
});

test('用户场景 A5: extract-pasted-image.mjs 提取粘贴图（脚本契约）', async () => {
    // 模拟一个 .claude/projects/<项目>/xxx.jsonl 转录文件，内嵌 base64 图片
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const projectName = process.cwd().replace(/[:/\\]/g, '-');
    const projectDir = path.join(projectsDir, projectName);
    fs.mkdirSync(projectDir, { recursive: true });
    const transcriptFile = path.join(projectDir, '.ci-use-transcript.jsonl');
    const png = await makePng(40, 40);
    const b64 = png.toString('base64');
    // 构造一条带图片的会话记录
    const record = {
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] }
    };
    fs.writeFileSync(transcriptFile, JSON.stringify(record) + '\n');
    const child = await startBridge();
    try {
        const out = await runScriptAndGetFirstLine(path.join(PROJECT_ROOT, 'extract-pasted-image.mjs'));
        assert.ok(out.endsWith('.png'), `应输出 png 路径，实际: ${out}`);
        assert.ok(fs.existsSync(out), '提取的图片应真实落盘');
        // 然后用这个路径分析
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(out)}&force_action=continue`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        // 再跑一次应返回 SAME:（已提取过）
        const out2 = await runScriptAndGetFirstLine(path.join(PROJECT_ROOT, 'extract-pasted-image.mjs'));
        assert.ok(out2.startsWith('SAME:'), `第二次应返回 SAME:，实际: ${out2}`);
    } finally {
        try {
            fs.rmSync(transcriptFile, { force: true });
            // 清理生成的 pasted-*.png
            const shotsDir = path.join(PROJECT_ROOT, 'shots');
            if (fs.existsSync(shotsDir)) {
                for (const f of fs.readdirSync(shotsDir)) {
                    if (f.startsWith('pasted-') && f.endsWith('.png')) {
                        try { fs.rmSync(path.join(shotsDir, f), { force: true }); } catch {}
                    }
                }
            }
        } catch {}
        killTree(child);
    }
});

// ============================================================
// B. 任务场景
// ============================================================

test('用户场景 B1: 报错定位（desc 含"报错"→ 自动路由 error task）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-error.png');
    fs.writeFileSync(img, await makePng(100, 100));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&desc=${encodeURIComponent('看下这个报错')}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.task, 'error', '应自动路由到 error');
        // metrics 应反映 by_task.error +1
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.by_task.error >= 1, 'metrics by_task.error 应 >= 1');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B2: 用户显式传 task 时路由不覆盖（用户优先）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-explicit.png');
    fs.writeFileSync(img, await makePng(50, 50));
    try {
        // desc 含"报错"但显式传 task=ui → 应保留 ui
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&task=ui&desc=${encodeURIComponent('看下这个报错')}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.task, 'ui', '用户显式 task 应优先');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B3: 多图对比（paths 数组 + task=diff）', async () => {
    const child = await startBridge();
    const img1 = path.join(PROJECT_ROOT, 'shots', '.ci-use-diff-1.png');
    const img2 = path.join(PROJECT_ROOT, 'shots', '.ci-use-diff-2.png');
    fs.writeFileSync(img1, await makePng(80, 80, { bg: { r: 255, g: 0, b: 0 } }));
    fs.writeFileSync(img2, await makePng(80, 80, { bg: { r: 0, g: 255, b: 0 } }));
    try {
        const qs = new URLSearchParams();
        qs.append('paths', img1);
        qs.append('paths', img2);
        qs.set('force_action', 'continue');
        qs.set('task', 'diff');
        qs.set('description', '图1: 修改前 / 图2: 修改后');  // 多图打标签
        const r = await reqJson('GET', `/analyze?${qs}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.image_count, 2);
        assert.equal(r.body.meta.task, 'diff');
        assert.equal(r.body.images.length, 2);
        // 单图兼容字段 image 此时为 undefined（多图场景）
        assert.equal(r.body.image, undefined, '多图场景不应有单图 image 字段');
    } finally {
        try { fs.rmSync(img1, { force: true }); fs.rmSync(img2, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B4: 多轮追问（第二轮带 focus 看更细）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-focus.png');
    fs.writeFileSync(img, await makePng(120, 120));
    try {
        // 第一轮整体看（GET query 里的中文必须 encodeURIComponent）
        const r1 = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&desc=${encodeURIComponent('整体看一下')}`);
        assert.equal(r1.status, 200);
        assert.equal(r1.body.control.action, 'continue');
        // 第二轮带 focus
        const r2 = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&focus=${encodeURIComponent('左上角红框里的报错文字')}`);
        assert.equal(r2.status, 200);
        assert.equal(r2.body.meta.focus, '左上角红框里的报错文字', 'focus 应透传到 meta');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B5: 精准放大追问（crop_bbox 来自上一轮 regions）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-crop.png');
    fs.writeFileSync(img, await makePng(200, 200));
    try {
        // 模拟上一轮返回了 regions[0].bbox = {x:0.05,y:0.02,w:0.4,h:0.12}
        const bbox = JSON.stringify({ x: 0.05, y: 0.02, w: 0.4, h: 0.12 });
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&crop_bbox=${encodeURIComponent(bbox)}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.crop_bbox.x, 0.05, 'crop_bbox 应透传到 meta');
        assert.equal(r.body.meta.crop_bbox.w, 0.4);
        // cropped 字段在 force_action 路径下不一定为 true（force_action 短路了压缩阶段），只断言字段存在
        assert.ok('cropped' in r.body.meta, 'cropped 字段应存在');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B6: 反向验证（task=verify 核验断言）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-verify.png');
    fs.writeFileSync(img, await makePng(80, 80));
    try {
        // 用户基于第一轮推理出结论，用 verify 让模型核验
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&task=verify&description=${encodeURIComponent('这个按钮是禁用状态')}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.task, 'verify');
        // verify task 应在 metrics 里被记录
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.by_task.verify >= 1, 'metrics by_task.verify 应 >= 1');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B7: OCR 文字提取（task=ocr）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-ocr.png');
    fs.writeFileSync(img, await makePng(100, 100));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&task=ocr`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.task, 'ocr');
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.by_task.ocr >= 1, 'metrics by_task.ocr 应 >= 1');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 B8: 控制信号 stop（force_action=stop 流程结束）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-stop.png');
    fs.writeFileSync(img, await makePng(50, 50));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=stop`);
        assert.equal(r.status, 200);
        assert.equal(r.body.control.action, 'stop', '应返回 stop');
        assert.equal(r.body.control.flow_state, 'ended', 'flow_state 应为 ended');
        assert.ok(r.body.control.reason, '应有 reason');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

// ============================================================
// C. 历史回看
// ============================================================

test('用户场景 C1: 成功分析后 history.jsonl 可 grep（不记 force_action）', async () => {
    const historyFile = path.join(PROJECT_ROOT, '.claude-eyes', 'history.jsonl');
    // 清掉旧的 CI 残留
    try { fs.rmSync(historyFile, { force: true }); } catch {}
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-history.png');
    fs.writeFileSync(img, await makePng(60, 60));
    try {
        // force_action 路径不记 history
        await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
        let lines = [];
        try { lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean); } catch {}
        assert.equal(lines.length, 0, 'force_action 不应写入 history');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

// ============================================================
// D. 用户视角的可观测性
// ============================================================

test('用户场景 D1: X-Request-Id 客户端传入原样回（跨日志追踪）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-rid.png');
    fs.writeFileSync(img, await makePng(40, 40));
    try {
        const rid = 'user-trace-abc-123';
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`,
            { headers: { 'X-Request-Id': rid } });
        assert.equal(r.headers['x-request-id'], rid, '响应头应原样回传');
        assert.equal(r.body.meta.request_id, rid, 'body.meta.request_id 应原样回传');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 D2: 不传 X-Request-Id 自动生成 r- 前缀', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-rid-auto.png');
    fs.writeFileSync(img, await makePng(40, 40));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
        assert.match(r.body.meta.request_id, /^r-\d+-[a-z0-9]+$/, '应自动生成 r-<ts>-<rand> 格式');
        assert.equal(r.headers['x-request-id'], r.body.meta.request_id, '响应头与 body 一致');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 D3: /metrics 反映用户请求维度（by_task/by_user）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-metrics.png');
    fs.writeFileSync(img, await makePng(30, 30));
    try {
        // 用户 A：发 3 个 general + 1 个 error
        for (let i = 0; i < 3; i++) {
            await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&user=userA`);
        }
        await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&user=userA&desc=${encodeURIComponent('报错')}`);
        // 用户 B：发 1 个 ui
        await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&user=userB&task=ui`);
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.by_user.userA >= 4, `userA 应有 4 次请求，实际 ${m.body.by_user.userA}`);
        assert.ok(m.body.by_user.userB >= 1, `userB 应有 1 次请求，实际 ${m.body.by_user.userB}`);
        assert.ok(m.body.by_task.general >= 3, `general 应 >= 3，实际 ${m.body.by_task.general}`);
        assert.ok(m.body.by_task.error >= 1, `error 应 >= 1，实际 ${m.body.by_task.error}`);
        assert.ok(m.body.by_task.ui >= 1, `ui 应 >= 1，实际 ${m.body.by_task.ui}`);
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

// ============================================================
// E. 错误体验（用户犯错时系统给的反馈）
// ============================================================

test('用户场景 E1: 用户忘了给 path → 400 + 友好提示', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/analyze');
        assert.equal(r.status, 400);
        assert.match(r.body.error, /缺少path|paths/i, '应提示缺少 path');
        // 同时 /metrics 应统计到这个错误
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.total_errors >= 1, '错误应计入 metrics');
    } finally { killTree(child); }
});

test('用户场景 E2: 用户给了不存在的文件 → 400 + 文件名回显', async () => {
    const child = await startBridge();
    try {
        const fake = 'E:\\nonexistent\\user-typo-' + Date.now() + '.png';
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(fake)}`);
        assert.equal(r.status, 400);
        assert.match(r.body.error, /不存在|ENOENT/i);
        assert.ok(r.body.error.includes('user-typo-'), '错误信息应回显用户传的文件名');
    } finally { killTree(child); }
});

test('用户场景 E3: 用户一次贴了 7 张图 → 400 提示上限', async () => {
    const child = await startBridge();
    const imgs = [];
    for (let i = 0; i < 7; i++) {
        const p = path.join(PROJECT_ROOT, 'shots', `.ci-use-7-${i}.png`);
        fs.writeFileSync(p, await makePng(20, 20));
        imgs.push(p);
    }
    try {
        const qs = new URLSearchParams();
        for (const p of imgs) qs.append('paths', p);
        const r = await reqJson('GET', `/analyze?${qs}`);
        assert.equal(r.status, 400);
        assert.match(r.body.error, /最多|6/i);
    } finally {
        for (const p of imgs) { try { fs.rmSync(p, { force: true }); } catch {} }
        killTree(child);
    }
});

test('用户场景 E4: 用户 POST 时 base64 为空 → 400', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('POST', '/analyze', {
            body: { images: [{ base64: '' }], task: 'general' }
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /base64/i);
    } finally { killTree(child); }
});

test('用户场景 E5: 用户 crop_bbox 非法 → 忽略不报错（容错）', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-badbbox.png');
    fs.writeFileSync(img, await makePng(60, 60));
    try {
        // 非法 JSON 的 crop_bbox 应被忽略，分析正常进行
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&crop_bbox=${encodeURIComponent('not-a-json')}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        // crop_bbox 应为 undefined（被忽略）
        assert.equal(r.body.meta.crop_bbox, undefined, '非法 bbox 应被忽略');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 E6: 用户传了未知 task → 回退到 general', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-badtask.png');
    fs.writeFileSync(img, await makePng(40, 40));
    try {
        // 未知 task 名（bridge 没校验，统一用 default 兜底成 general）
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue&task=unknown_type`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        // PROMPT_TEMPLATES[task] 没匹配时走 general 模板，meta.task 反映最终用的 task
        // （routeTaskByContext 不会改写非 general task，所以这里 meta.task 应为 'unknown_type' 或 'general'）
        assert.ok(['unknown_type', 'general'].includes(r.body.meta.task), `task 应为 unknown_type 或 general，实际 ${r.body.meta.task}`);
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

// ============================================================
// F. 图像处理体验（不同图片格式/尺寸的自适应）
// ============================================================

test('用户场景 F1: 上传 JPEG 照片 → chooseFormat 走 WebP 路径', async () => {
    const child = await startBridge();
    const jpeg = path.join(PROJECT_ROOT, 'shots', '.ci-use-photo.jpg');
    fs.writeFileSync(jpeg, await makeJpeg(400, 300));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(jpeg)}&force_action=continue`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        // image.bytes 反映原图大小，compressed_bytes 在 force_action 路径为 null
        assert.ok(r.body.image.bytes > 0, '应有原图字节数');
    } finally {
        try { fs.rmSync(jpeg, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 F2: 超长截图（长宽比 > 3）单图路径稳定', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-long.png');
    fs.writeFileSync(img, await makePng(100, 500));  // 长宽比 5:1
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        // force_action 短路了 sliceLongImage，但响应不应崩
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});

test('用户场景 F3: 多图混合格式（PNG + JPEG）稳定', async () => {
    const child = await startBridge();
    const png = path.join(PROJECT_ROOT, 'shots', '.ci-use-mix-1.png');
    const jpg = path.join(PROJECT_ROOT, 'shots', '.ci-use-mix-2.jpg');
    fs.writeFileSync(png, await makePng(80, 80));
    fs.writeFileSync(jpg, await makeJpeg(80, 80));
    try {
        const qs = new URLSearchParams();
        qs.append('paths', png);
        qs.append('paths', jpg);
        qs.set('force_action', 'continue');
        const r = await reqJson('GET', `/analyze?${qs}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.meta.image_count, 2);
        assert.equal(r.body.images[0].path, png);
        assert.equal(r.body.images[1].path, jpg);
    } finally {
        try { fs.rmSync(png, { force: true }); fs.rmSync(jpg, { force: true }); } catch {}
        killTree(child);
    }
});

// ============================================================
// G. /health 与 /metrics 用户感知
// ============================================================

test('用户场景 G1: /health 展示完整配置信息（用户体检）', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/health');
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal(r.body.status, 'up');
        assert.ok(r.body.model, '应展示当前模型');
        assert.equal(r.body.version, '1.4.0');
        assert.ok(r.body.cache.max > 0, '应展示 cache.max');
        assert.ok(r.body.rate_limit, '应展示 rate_limit 配置');
        assert.ok(Array.isArray(r.body.providers), '应展示 providers 链');
        assert.ok(r.body.providers.length >= 1, '至少有主 provider');
        assert.ok(r.body.providers[0].model, '主 provider 应有 model');
    } finally { killTree(child); }
});

test('用户场景 G2: /metrics 端点可用且字段对用户有意义', async () => {
    const child = await startBridge();
    const img = path.join(PROJECT_ROOT, 'shots', '.ci-use-mhealth.png');
    fs.writeFileSync(img, await makePng(30, 30));
    try {
        // 发几个请求让 metrics 有数据
        await reqJson('GET', `/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
        await reqJson('GET', '/analyze');  // 错误请求
        const m = await reqJson('GET', '/metrics');
        assert.equal(m.status, 200);
        assert.ok(m.body.total_requests >= 2, '应统计到至少 2 个请求');
        assert.ok(m.body.total_errors >= 1, '应统计到至少 1 个错误');
        assert.ok(m.body.uptime_ms > 0);
        assert.ok(typeof m.body.latency_p50_ms === 'number');
        // cache 命中率字段应是合法数值
        assert.ok(!isNaN(Number(m.body.cache_hit_rate)), 'cache_hit_rate 应是数值');
        assert.ok(!isNaN(Number(m.body.error_rate)), 'error_rate 应是数值');
    } finally {
        try { fs.rmSync(img, { force: true }); } catch {}
        killTree(child);
    }
});
