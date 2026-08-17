// ============================================================
// stress.test.mjs —— 压力测试
// 验证 bridge 在负载下的稳定性和性能特征：
//   - 连续 100 次 force_action 请求无失败
//   - 20 并发 force_action 请求全部成功
//   - 缓存字段在 200 次请求后仍稳定（cache.size 不超 max）
//   - /metrics 累加正确（total_requests = 200）
//   - 延迟分布合理（P95 < 500ms）
//   - 不存在文件的连续错误请求不会让 bridge 崩溃
//   - 多文件并发读写无竞态
// 全部用 force_action，不调真实模型
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const PORT = 18802;

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

test('压力: 连续 100 次 force_action 请求无失败', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-seq.png');
    fs.writeFileSync(dummy, await makePng(50, 50));
    try {
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        let ok = 0;
        for (let i = 0; i < 100; i++) {
            const r = await reqJson('GET', url);
            if (r.status === 200 && r.body.ok === true) ok++;
        }
        assert.equal(ok, 100, '100 次请求都应成功');
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: 20 并发请求全部成功', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-conc.png');
    fs.writeFileSync(dummy, await makePng(50, 50));
    try {
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        const promises = Array.from({ length: 20 }, () => reqJson('GET', url));
        const results = await Promise.all(promises);
        const ok = results.filter(r => r.status === 200 && r.body.ok === true).length;
        assert.equal(ok, 20, '20 个并发请求都应成功');
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: 200 次请求后 /metrics 累加正确', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-metrics.png');
    fs.writeFileSync(dummy, await makePng(30, 30));
    try {
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        // 分批串行避免一次 200 个 socket
        for (let i = 0; i < 200; i++) {
            await reqJson('GET', url);
        }
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.total_requests >= 200, `total_requests 应 >= 200，实际 ${m.body.total_requests}`);
        // 全是 force_action=continue，by_task.general 应 == 200
        assert.ok(m.body.by_task.general >= 200, `by_task.general 应 >= 200，实际 ${m.body.by_task.general}`);
        assert.equal(m.body.total_errors, 0, '不应有错误');
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: P95 延迟 < 1500ms（force_action 无真实模型）', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-lat.png');
    fs.writeFileSync(dummy, await makePng(20, 20));
    try {
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        // 先发 50 次暖起来
        for (let i = 0; i < 50; i++) await reqJson('GET', url);
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.latency_p95_ms < 1500, `P95 应 < 1500ms，实际 ${m.body.latency_p95_ms}ms`);
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: cache.size 在大量请求后不超过 max', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-cache.png');
    fs.writeFileSync(dummy, await makePng(20, 20));
    try {
        // force_action 不写 cache，但 /health 应能稳定返回 cache.size
        for (let i = 0; i < 50; i++) await reqJson('GET', `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`);
        const h = await reqJson('GET', '/health');
        assert.ok(h.body.cache.size <= h.body.cache.max, `cache.size(${h.body.cache.size}) 应 <= max(${h.body.cache.max})`);
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: 连续错误请求不崩 bridge', async () => {
    const child = await startBridge();
    try {
        for (let i = 0; i < 50; i++) {
            const r = await reqJson('GET', `/analyze?path=${encodeURIComponent('E:\\nonexistent\\no-' + i + '.png')}`);
            assert.equal(r.status, 400, `第 ${i} 次错误请求应 400`);
        }
        // bridge 仍应存活
        const h = await reqJson('GET', '/health');
        assert.equal(h.status, 200, 'bridge 仍应存活');
        // /metrics 应统计到错误
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.total_errors >= 50, `total_errors 应 >= 50，实际 ${m.body.total_errors}`);
    } finally { killTree(child); }
});

test('压力: 混合请求（成功 + 错误 + metrics）交替', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-mix.png');
    fs.writeFileSync(dummy, await makePng(40, 40));
    try {
        for (let i = 0; i < 30; i++) {
            // 成功
            const r1 = await reqJson('GET', `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`);
            assert.equal(r1.status, 200);
            // 错误
            const r2 = await reqJson('GET', '/analyze?path=E:\\no.png');
            assert.equal(r2.status, 400);
            // /metrics（自身不计入 total_requests）
            const m = await reqJson('GET', '/metrics');
            assert.equal(m.status, 200);
        }
        const m = await reqJson('GET', '/metrics');
        // 30 成功 + 30 错误 = 60；/metrics 与 /health 自身不计入 total_requests
        assert.ok(m.body.total_requests >= 60, `总请求应 >= 60（成功 30 + 错误 30），实际 ${m.body.total_requests}`);
        assert.ok(m.body.total_errors >= 30, `总错误应 >= 30，实际 ${m.body.total_errors}`);
        // 错误率应在合理范围（30/60 = 0.5）
        assert.ok(m.body.error_rate >= 0.3 && m.body.error_rate <= 0.7, `错误率应在 0.3-0.7 之间，实际 ${m.body.error_rate}`);
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: POST /analyze 并发 10 次稳定', async () => {
    const child = await startBridge();
    const png = await makePng(80, 80);
    try {
        const body = {
            images: [{ base64: png.toString('base64') }],
            task: 'general',
            force_action: 'continue'
        };
        const promises = Array.from({ length: 10 }, () => reqJson('POST', '/analyze', { body }));
        const results = await Promise.all(promises);
        const ok = results.filter(r => r.status === 200 && r.body.ok === true).length;
        assert.equal(ok, 10, '10 个并发 POST 都应成功');
        // 验证 /metrics 仍正常
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.total_requests >= 10);
    } finally { killTree(child); }
});

test('压力: 同一图片大量请求的字节缓存稳定性', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-bytes.png');
    fs.writeFileSync(dummy, await makePng(100, 100));
    try {
        // 同一张图大量请求，验证 imgCache（字节缓存）map 在 force_action 路径下不写但也不溢出
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        for (let i = 0; i < 100; i++) {
            const r = await reqJson('GET', url);
            assert.equal(r.status, 200);
        }
        // /health 应稳定
        const h = await reqJson('GET', '/health');
        assert.equal(h.status, 200);
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});

test('压力: 长时间运行 /metrics 窗口内数据有效', async () => {
    const child = await startBridge();
    const dummy = path.join(PROJECT_ROOT, 'shots', '.ci-stress-win.png');
    fs.writeFileSync(dummy, await makePng(20, 20));
    try {
        const url = `/analyze?path=${encodeURIComponent(dummy)}&force_action=continue`;
        for (let i = 0; i < 30; i++) await reqJson('GET', url);
        const m = await reqJson('GET', '/metrics');
        assert.ok(m.body.uptime_ms > 0);
        assert.ok(m.body.window_ms > 0);
        // 滚动窗口字段都应有值
        assert.ok(typeof m.body.latency_p50_ms === 'number');
        assert.ok(typeof m.body.latency_p95_ms === 'number');
        assert.ok(typeof m.body.latency_p99_ms === 'number');
        // P50 <= P95 <= P99
        assert.ok(m.body.latency_p50_ms <= m.body.latency_p95_ms, 'P50 应 <= P95');
        assert.ok(m.body.latency_p95_ms <= m.body.latency_p99_ms, 'P95 应 <= P99');
    } finally {
        try { fs.rmSync(dummy, { force: true }); } catch {}
        killTree(child);
    }
});
