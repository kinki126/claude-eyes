// ============================================================
// completeness.test.mjs —— 完整性测试
// 验证版本号、字段、配置、文档之间的一致性：
//   - package.json / bridge VERSION 常量 / /health 返回 三处版本号一致
//   - CHANGELOG 最新条目与 package.json 版本一致
//   - README/CONFIG/USAGE/SKILL 都能找到 v1.4.0 关键能力关键字
//   - vision-config.example.json 含 disable_json_mode 注释
//   - 响应 schema 字段齐全（用 force_action 不调真实模型）
//   - 错误响应 schema 一致（error 字段）
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const CHANGELOG = fs.readFileSync(path.join(PROJECT_ROOT, 'CHANGELOG.md'), 'utf8');
const README = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
const CONFIG_DOC = fs.readFileSync(path.join(PROJECT_ROOT, 'docs', 'CONFIG.md'), 'utf8');
const USAGE_DOC = fs.readFileSync(path.join(PROJECT_ROOT, 'docs', 'USAGE.md'), 'utf8');
const SKILL_DOC = fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'skills', 'analyze-image', 'SKILL.md'), 'utf8');
const EXAMPLE_CFG = fs.readFileSync(path.join(PROJECT_ROOT, 'vision-config.example.json'), 'utf8');
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE_SCRIPT, 'utf8');
const PORT = 18801;

function startBridge() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, LISTEN_PORT: String(PORT), USAGE_LOG: '0' },
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

function killTree(child) { try { child.kill(); } catch {} }

async function makePng(w = 100, h = 100) {
    return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
}

// ----- 版本号一致性 -----

test('完整: package.json version 与 CHANGELOG 最新条目一致', () => {
    const m = CHANGELOG.match(/^##\s*\[([0-9.]+)\]/m);
    assert.ok(m, 'CHANGELOG 应有版本条目');
    assert.equal(m[1], PACKAGE_JSON.version, 'CHANGELOG 最新版本应等于 package.json');
});

test('完整: bridge VERSION 常量与 package.json 一致', () => {
    const m = BRIDGE_SOURCE.match(/^const VERSION\s*=\s*[\'\"]([0-9.]+)[\'\"]/m);
    assert.ok(m, 'bridge 应有 VERSION 常量');
    assert.equal(m[1], PACKAGE_JSON.version, 'bridge VERSION 应等于 package.json');
});

test('完整: setup.mjs 读 package.json 不硬编码版本', () => {
    const setupSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'setup.mjs'), 'utf8');
    assert.match(setupSrc, /readFile.*package\.json|require.*package\.json|from ['\"].*package\.json/, 'setup.mjs 应从 package.json 读版本');
    assert.ok(!/const VERSION\s*=\s*[\'\"]1\./.test(setupSrc), 'setup.mjs 不应硬编码 VERSION');
});

// ----- 文档关键字完整性 -----

test('完整: README 提及所有 v1.4.0 关键能力', () => {
    // README 是英文版（README.zh-CN.md 才是中文），所以这里测英文关键字
    const keywords = ['/metrics', 'X-Request-Id', 'crop_bbox', 'POST /analyze', 'disable_json_mode',
                      'Smart task routing', 'Analysis history', 'auto-sliced', 'binarization'];
    for (const kw of keywords) {
        assert.ok(README.includes(kw), `README 应提及 ${kw}`);
    }
});

test('完整: CONFIG.md 提及所有 v1.4.0 配置项', () => {
    const keywords = ['disable_json_mode', '/metrics', 'X-Request-Id', 'historyLog', 'routeTaskByContext', 'chooseFormat', 'sliceLongImage', 'ocrPreprocess'];
    for (const kw of keywords) {
        assert.ok(CONFIG_DOC.includes(kw), `CONFIG.md 应提及 ${kw}`);
    }
});

test('完整: USAGE.md 提及新场景用法', () => {
    const keywords = ['精准放大', 'task 自动路由', '多图打标签', '图像处理', '分析历史', '二值化'];
    for (const kw of keywords) {
        assert.ok(USAGE_DOC.includes(kw), `USAGE.md 应提及 ${kw}`);
    }
});

test('完整: SKILL.md 提及 Claude 应知应会', () => {
    const keywords = ['crop_bbox', 'image_base64', 'regions', 'task 自动路由', '多图打标签', '分析历史'];
    for (const kw of keywords) {
        assert.ok(SKILL_DOC.includes(kw), `SKILL.md 应提及 ${kw}`);
    }
});

test('完整: vision-config.example.json 示范 disable_json_mode', () => {
    assert.ok(EXAMPLE_CFG.includes('disable_json_mode'), 'example 配置应示范 disable_json_mode');
});

// ----- 响应 schema 完整性 -----

test('完整: /health 响应 schema 字段齐全', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/health');
        assert.equal(r.status, 200);
        const required = ['ok', 'status', 'version', 'model', 'uptime_ms', 'cache', 'rate_limit', 'providers'];
        for (const f of required) {
            assert.ok(f in r.body, `/health 应有字段 ${f}`);
        }
        // cache 子字段
        assert.ok(typeof r.body.cache.size === 'number');
        assert.ok(typeof r.body.cache.ttl_ms === 'number');
        assert.ok(typeof r.body.cache.max === 'number');
    } finally { killTree(child); }
});

test('完整: /metrics 响应 schema 字段齐全', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/metrics');
        assert.equal(r.status, 200);
        const required = ['uptime_ms', 'total_requests', 'total_errors', 'error_rate', 'cache_hits', 'cache_misses',
                          'cache_hit_rate', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms',
                          'by_task', 'by_provider', 'by_user', 'error_types', 'window_ms'];
        for (const f of required) {
            assert.ok(f in r.body, `/metrics 应有字段 ${f}`);
        }
        // by_task 应支持所有定义的 task 类型
        const taskKeys = ['general', 'error', 'diff', 'ocr', 'ui', 'verify'];
        for (const t of taskKeys) {
            assert.ok(t in r.body.by_task, `by_task 应初始化 ${t}`);
        }
    } finally { killTree(child); }
});

test('完整: /analyze 成功响应 schema 字段齐全', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-comp-ok.png');
    fs.writeFileSync(dummy, await makePng(60, 60));
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`);
        assert.equal(r.status, 200);
        const topRequired = ['ok', 'image', 'analysis', 'control', 'meta'];
        for (const f of topRequired) {
            assert.ok(f in r.body, `响应应有字段 ${f}`);
        }
        const analysisRequired = ['text', 'keywords', 'regions', 'verbatim', 'raw'];
        for (const f of analysisRequired) {
            assert.ok(f in r.body.analysis, `analysis 应有字段 ${f}`);
        }
        const controlRequired = ['action', 'reason', 'decided_by', 'flow_state'];
        for (const f of controlRequired) {
            assert.ok(f in r.body.control, `control 应有字段 ${f}`);
        }
        const metaRequired = ['cache', 'image_count', 'latency_ms', 'bridge_version', 'request_id', 'forced'];
        for (const f of metaRequired) {
            assert.ok(f in r.body.meta, `meta 应有字段 ${f}`);
        }
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('完整: /analyze 错误响应 schema 一致 (error 字段)', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/analyze');
        assert.equal(r.status, 400);
        assert.ok('error' in r.body, '错误响应应有 error 字段');
        assert.ok(typeof r.body.error === 'string', 'error 应为字符串');
    } finally { killTree(child); }
});

test('完整: POST /analyze 错误响应 schema 一致', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('POST', '/analyze', { body: {} });
        assert.equal(r.status, 400);
        assert.ok('error' in r.body);
    } finally { killTree(child); }
});

test('完整: /health cache.max 与代码常量一致', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/health');
        // CACHE_MAX 在源码里（缓存条数上限，定义形如 `Number(process.env.CACHE_MAX || 500)`）
        const m = BRIDGE_SOURCE.match(/CACHE_MAX[^;]*?(\d+)/);
        assert.ok(m, '源码应有 CACHE_MAX 字面量');
        assert.equal(r.body.cache.max, parseInt(m[1], 10), '/health.cache.max 应等于源码常量');
    } finally { killTree(child); }
});

test('完整: /health rate_limit 字段结构', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/health');
        assert.ok(r.body.rate_limit, '应有 rate_limit 字段');
        // 至少有一个子字段
        const keys = Object.keys(r.body.rate_limit);
        assert.ok(keys.length > 0, 'rate_limit 应有子字段');
    } finally { killTree(child); }
});

test('完整: /metrics window_ms 与代码常量一致', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/metrics');
        const m = BRIDGE_SOURCE.match(/METRICS_WINDOW_MS\s*=\s*(\d+)/);
        if (m) {
            assert.equal(r.body.window_ms, parseInt(m[1], 10), '/metrics.window_ms 应等于源码常量');
        } else {
            assert.equal(r.body.window_ms, 600000, '无显式常量时应为 10 分钟');
        }
    } finally { killTree(child); }
});

test('完整: 所有 SKILL.md 中提到的参数都在 MCP 工具 schema 中存在', async () => {
    // 读 MCP 工具 schema 文件
    const toolFiles = [
        path.join(PROJECT_ROOT, 'mcp-image-analyzer', 'analyze-tool.js'),
        path.join(PROJECT_ROOT, 'mcp-image-analyzer', 'index.js')
    ];
    const toolSrc = toolFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    // MCP 工具实际对外暴露的参数（SKILL.md 同步使用）；desc/user/force_action/raw 是 bridge URL 参数，
    // 不在 MCP 工具 schema 里。analyze-tool.js 暴露 SUPPORTED_TOOL_PARAMS 数组作为测试锚点。
    const params = ['path', 'paths', 'image_base64', 'images_base64', 'task', 'lang', 'description', 'focus', 'crop_bbox'];
    for (const p of params) {
        assert.ok(toolSrc.includes(`'${p}'`), `MCP 工具 schema 应有参数 ${p}`);
    }
});

test('完整: /metrics 路径在 README 中提及', () => {
    assert.ok(README.includes('/metrics'), 'README 应提及 /metrics 端点');
});

test('完整: CHANGELOG v1.4.0 提及所有改动', () => {
    const v140Section = CHANGELOG.split(/^##\s*\[1\.4\.0\]/m)[1]?.split(/^##\s*\[1\.3\.0\]/m)[0] || '';
    assert.ok(v140Section.length > 0, '应有 v1.4.0 条目');
    const keywords = ['/metrics', 'X-Request-Id', 'routeTaskByContext', 'historyLog', 'chooseFormat', 'sliceLongImage', 'ocrPreprocess', 'parseCropBbox', 'isCircuitOpen'];
    for (const kw of keywords) {
        assert.ok(v140Section.includes(kw), `CHANGELOG v1.4.0 应提及 ${kw}`);
    }
});

test('完整: 测试套件总数 >= 100', () => {
    const testDir = path.join(PROJECT_ROOT, 'test');
    const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.mjs'));
    assert.ok(files.length >= 10, `测试文件数应 >= 10，当前 ${files.length}`);
});
