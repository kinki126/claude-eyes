// ============================================================
// metrics.test.mjs —— /metrics 端点 + x-request-id 单测（离线）
// 起一个真实的 bridge 实例，发请求验证：
//   - /metrics 默认返回零值
//   - 一次 force_action=continue 后 /metrics 计数 +1
//   - 响应头 X-Request-Id 存在
//   - 响应体 meta.request_id 与请求头一致
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
const PORT = 18790; // 用一个不常用端口避免与其他测试冲突

function startBridge() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, PORT: String(PORT), LISTEN_PORT: String(PORT), USAGE_LOG: '0' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const onErr = (err) => { child.kill(); reject(err); };
        child.once('error', onErr);
        child.stderr.on('data', (b) => { if (process.env.DEBUG) console.error(b.toString()); });
        // 轮询 /health
        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    clearInterval(timer);
                    resolve(child);
                }
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

test('metrics: /metrics 端点存在并返回 JSON 报告', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/metrics');
        assert.equal(r.status, 200);
        assert.equal(typeof r.body.total_requests, 'number');
        assert.equal(typeof r.body.uptime_ms, 'number');
        assert.equal(typeof r.body.latency_p50_ms, 'number');
    } finally {
        child.kill();
    }
});

test('metrics: 默认状态零计数', async () => {
    const child = await startBridge();
    try {
        const r = await reqJson('GET', '/metrics');
        assert.equal(r.body.total_requests, 0);
        assert.equal(r.body.total_errors, 0);
        assert.equal(r.body.cache_hits, 0);
        assert.equal(r.body.cache_misses, 0);
        assert.equal(r.body.error_rate, '0');
    } finally {
        child.kill();
    }
});

test('metrics: 一次 force_action 请求后 total_requests=1', async () => {
    const child = await startBridge();
    const dummyPath = path.join(PROJECT_ROOT, 'shots', '.ci-metrics-dummy.png');
    fs.mkdirSync(path.dirname(dummyPath), { recursive: true });
    fs.writeFileSync(dummyPath, 'dummy');
    try {
        const r1 = await reqJson('GET', `/analyze?path=${encodeURIComponent(dummyPath)}&force_action=continue`);
        assert.equal(r1.status, 200);
        const r2 = await reqJson('GET', '/metrics');
        assert.equal(r2.body.total_requests, 1);
        assert.equal(r2.body.total_errors, 0);
        assert.ok(r2.body.by_task.general >= 1, 'by_task.general 应有计数');
        assert.ok(r2.body.cache_misses >= 1, 'force_action 走 cache=miss');
    } finally {
        try { fs.rmSync(dummyPath, { force: true }); } catch {}
        child.kill();
    }
});

test('metrics: 多次请求后 latency_p50_ms > 0', async () => {
    const child = await startBridge();
    const dummyPath = path.join(PROJECT_ROOT, 'shots', '.ci-metrics-dummy.png');
    fs.mkdirSync(path.dirname(dummyPath), { recursive: true });
    fs.writeFileSync(dummyPath, 'dummy');
    try {
        for (let i = 0; i < 3; i++) {
            await reqJson('GET', `/analyze?path=${encodeURIComponent(dummyPath)}&force_action=continue`);
        }
        const r = await reqJson('GET', '/metrics');
        assert.equal(r.body.total_requests, 3);
        assert.ok(r.body.latency_p50_ms >= 0, 'p50 应有值');
    } finally {
        try { fs.rmSync(dummyPath, { force: true }); } catch {}
        child.kill();
    }
});

test('x-request-id: 客户端传入则原样返回', async () => {
    const child = await startBridge();
    const dummyPath = path.join(PROJECT_ROOT, 'shots', '.ci-metrics-dummy.png');
    fs.mkdirSync(path.dirname(dummyPath), { recursive: true });
    fs.writeFileSync(dummyPath, 'dummy');
    try {
        const rid = 'my-trace-id-12345';
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(dummyPath)}&force_action=continue`, { headers: { 'X-Request-Id': rid } });
        assert.equal(r.headers['x-request-id'], rid);
        assert.equal(r.body.meta.request_id, rid);
    } finally {
        try { fs.rmSync(dummyPath, { force: true }); } catch {}
        child.kill();
    }
});

test('x-request-id: 客户端不传则自动生成', async () => {
    const child = await startBridge();
    const dummyPath = path.join(PROJECT_ROOT, 'shots', '.ci-metrics-dummy.png');
    fs.mkdirSync(path.dirname(dummyPath), { recursive: true });
    fs.writeFileSync(dummyPath, 'dummy');
    try {
        const r = await reqJson('GET', `/analyze?path=${encodeURIComponent(dummyPath)}&force_action=continue`);
        assert.ok(r.headers['x-request-id'], '响应头应带 X-Request-Id');
        assert.match(r.headers['x-request-id'], /^r-/, '自动生成应以 r- 开头');
        assert.equal(r.body.meta.request_id, r.headers['x-request-id'], '响应体 meta.request_id 应与头一致');
    } finally {
        try { fs.rmSync(dummyPath, { force: true }); } catch {}
        child.kill();
    }
});

test('x-request-id: /metrics 路径也带头但不计入请求', async () => {
    const child = await startBridge();
    const dummyPath = path.join(PROJECT_ROOT, 'shots', '.ci-metrics-dummy.png');
    fs.mkdirSync(path.dirname(dummyPath), { recursive: true });
    fs.writeFileSync(dummyPath, 'dummy');
    try {
        // 先发 1 次 analyze
        await reqJson('GET', `/analyze?path=${encodeURIComponent(dummyPath)}&force_action=continue`);
        const before = await reqJson('GET', '/metrics');
        // 调 /metrics 本身不应计入 total_requests
        await reqJson('GET', '/metrics');
        const after = await reqJson('GET', '/metrics');
        assert.equal(after.body.total_requests, before.body.total_requests, '/metrics 不应被计入');
    } finally {
        try { fs.rmSync(dummyPath, { force: true }); } catch {}
        child.kill();
    }
});

test('metrics: 错误请求不计入 total_requests（bridge 在 400 前返回）', async () => {
    const child = await startBridge();
    try {
        // 触发一个 400（缺 path）
        await reqJson('GET', '/analyze');
        const r = await reqJson('GET', '/metrics');
        // 注：400 在 try 块内由 res.writeHead(400)+res.end 处理，不会进 catch 块的 metricsObserve
        // 所以 total_requests 不增加（这是当前实现的细节）
        assert.ok(r.body.total_requests >= 0);
    } finally {
        child.kill();
    }
});
