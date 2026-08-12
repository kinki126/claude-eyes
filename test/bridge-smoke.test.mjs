// ============================================================
// bridge-smoke.test.mjs —— 桥接离线冒烟（用 force_action，不调用真实模型）
// 在独立端口起一个桥接实例，验证 /health、force_action 统一响应、错误路径。
// 运行：node --test test/  （或 npm test）
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.TEST_PORT || 18765);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        }).on('error', reject);
    });
}

function waitForHealth(tries = 30) {
    const url = `http://127.0.0.1:${PORT}/health`;
    return new Promise((resolve) => {
        const tick = async (n) => {
            if (n <= 0) return resolve(false);
            try { const r = await httpGet(url); if (r.status === 200) return resolve(true); } catch { /* 未就绪 */ }
            setTimeout(() => tick(n - 1), 400);
        };
        tick(tries);
    });
}

function killTree(child) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
}

test('桥接离线冒烟（/health、force_action、错误路径）', async () => {
    const child = spawn(process.execPath, ['zhipu-bridge-api.js'], {
        cwd: projectRoot,
        env: { ...process.env, LISTEN_PORT: String(PORT), USAGE_LOG: '0' },
        stdio: 'ignore'
    });
    child.unref();

    try {
        const up = await waitForHealth();
        assert.ok(up, '桥接应在数秒内启动');

        const health = await httpGet(`http://127.0.0.1:${PORT}/health`);
        assert.equal(health.status, 200);
        const h = JSON.parse(health.body);
        assert.equal(h.ok, true);
        assert.equal(h.status, 'up');

        // force_action 只读文件算 md5，不调模型 → 离线可用
        const img = path.join(projectRoot, 'shots', '.ci-dummy.png');
        fs.mkdirSync(path.dirname(img), { recursive: true });
        fs.writeFileSync(img, 'dummy-image-bytes');
        try {
            const r = await httpGet(`http://127.0.0.1:${PORT}/analyze?path=${encodeURIComponent(img)}&force_action=continue`);
            assert.equal(r.status, 200);
            const j = JSON.parse(r.body);
            assert.equal(j.ok, true);
            assert.equal(j.control.action, 'continue');
            assert.equal(j.control.flow_state, 'active');
            assert.equal(j.meta.forced, true);
        } finally {
            try { fs.rmSync(img, { force: true }); } catch { /* ignore */ }
        }

        // 不存在的文件 → 400
        const bad = await httpGet(`http://127.0.0.1:${PORT}/analyze?path=${encodeURIComponent(path.join(projectRoot, 'no-such-file.png'))}`);
        assert.equal(bad.status, 400);
    } finally {
        killTree(child);
    }
});
