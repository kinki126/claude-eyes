// ============================================================
// mcp-tool.test.mjs —— MCP 工具层测试（P0-2 进度通知 / P1-1 locate_code）
// 直接调 handler 函数，不启动真实 MCP server
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// ESM import for analyze-tool.js
const { createAnalyzeImageHandler, createLocateCodeHandler, createSearchHistoryHandler } = await import('../mcp-image-analyzer/analyze-tool.js');

// ---------- P0-2: createAnalyzeImageHandler 的 extra/进度通知 ----------

test('P0-2: handler 接受 extra 参数，extra.sendNotification 被调用', async () => {
    const notifications = [];
    const fakeExtra = {
        sendNotification: async (notif) => { notifications.push(notif); }
    };
    const handler = createAnalyzeImageHandler({ bridgeBaseUrl: 'http://127.0.0.1:1' }); // 故意用不通的端口
    const result = await handler({
        path: 'E:\\nonexistent\\test.png'
    }, fakeExtra);

    // bridge 不通 → 应返回 isError
    assert.ok(result.isError, 'bridge 不通应返回 isError');
    // 应至少发了一条 notification（准备分析 / 桥接失败）
    assert.ok(notifications.length > 0, '应发送至少一条进度通知');
    // 所有 notification 的 method 应是 notifications/message
    for (const n of notifications) {
        assert.equal(n.method, 'notifications/message');
        assert.ok(n.params.level, 'notification 应有 level');
        assert.ok(n.params.data, 'notification 应有 data');
    }
});

test('P0-2: handler 缺少图片参数时不发通知直接返回 isError', async () => {
    const notifications = [];
    const fakeExtra = {
        sendNotification: async (notif) => { notifications.push(notif); }
    };
    const handler = createAnalyzeImageHandler({ bridgeBaseUrl: 'http://127.0.0.1:1' });
    const result = await handler({}, fakeExtra);

    assert.ok(result.isError, '缺参数应返回 isError');
    // 缺参数在发通知之前就 return 了
    assert.equal(notifications.length, 0, '缺参数不应发通知');
});

test('P0-2: handler 无 extra 参数时不崩溃（兼容旧调用方式）', async () => {
    const handler = createAnalyzeImageHandler({ bridgeBaseUrl: 'http://127.0.0.1:1' });
    // 不传 extra
    const result = await handler({ path: 'E:\\nonexistent\\test.png' });
    assert.ok(result.isError, '应返回 isError');
    // 不应因 sendNotification 未定义而崩溃
});

// ---------- P1-1: createLocateCodeHandler ----------

test('P1-1: locate_code 缺 keywords 参数返回 isError', async () => {
    const handler = createLocateCodeHandler();
    const result = await handler({}, {});
    assert.ok(result.isError);
    assert.match(result.content[0].text, /keywords/);
});

test('P1-1: locate_code 关键词超过 10 个返回 isError', async () => {
    const handler = createLocateCodeHandler();
    const result = await handler({ keywords: Array(11).fill('kw') }, {});
    assert.ok(result.isError);
    assert.match(result.content[0].text, /最多 10/);
});

test('P1-1: locate_code 搜索项目根能找到命中', async () => {
    const handler = createLocateCodeHandler({ defaultProjectRoot: PROJECT_ROOT });
    // 搜索 zhipu-bridge-api.js 里的已知函数名
    const result = await handler({
        keywords: ['routeTaskByContext'],
        max_hits_per_keyword: 3
    }, {});
    assert.ok(!result.isError, '搜索不应报错');
    const body = JSON.parse(result.content[0].text);
    assert.ok(body.total_hits >= 1, `应至少找到 1 个命中，实际 ${body.total_hits}`);
    assert.ok(body.search_engine, '应返回 search_engine 字段');
    assert.equal(body.keywords_searched, 1);
    // 至少一个命中包含 routeTaskByContext
    const allHits = body.results.flatMap(r => r.hits);
    assert.ok(allHits.some(h => h.file.includes('zhipu-bridge-api.js')), '应在 zhipu-bridge-api.js 里命中');
    assert.ok(allHits.every(h => typeof h.line === 'number'), '每条命中应有 line 数字');
    assert.ok(allHits.every(h => typeof h.match === 'string'), '每条命中应有 match 字符串');
});

test('P1-1: locate_code 搜索不存在的关键词返回 0 命中', async () => {
    const handler = createLocateCodeHandler({ defaultProjectRoot: PROJECT_ROOT });
    // 用动态生成的字符串避免测试文件自身被命中
    const fakeKeyword = `NONEXISTENT_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const result = await handler({
        keywords: [fakeKeyword],
        max_hits_per_keyword: 5
    }, {});
    assert.ok(!result.isError);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.total_hits, 0, '不存在的关键词应返回 0 命中');
});

test('P1-1: locate_code 多关键词搜索', async () => {
    const handler = createLocateCodeHandler({ defaultProjectRoot: PROJECT_ROOT });
    const result = await handler({
        keywords: ['routeTaskByContext', 'buildHint'],
        max_hits_per_keyword: 2
    }, {});
    assert.ok(!result.isError);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.results.length, 2, '应返回 2 个关键词的结果');
    assert.ok(body.results[0].keyword === 'routeTaskByContext');
    assert.ok(body.results[1].keyword === 'buildHint');
    // 每个关键词都应有 hits_count 字段
    assert.ok(typeof body.results[0].hits_count === 'number');
    assert.ok(typeof body.results[1].hits_count === 'number');
});

test('P1-1: locate_code 自定义 file_extensions 限制搜索范围', async () => {
    const handler = createLocateCodeHandler({ defaultProjectRoot: PROJECT_ROOT });
    // 只搜 .py 文件 → routeTaskByContext 应该 0 命中（项目里没有 .py 文件含此词）
    const result = await handler({
        keywords: ['routeTaskByContext'],
        file_extensions: ['.py'],
        max_hits_per_keyword: 5
    }, {});
    assert.ok(!result.isError);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.total_hits, 0, '限定 .py 文件应 0 命中');
});

test('P1-1: locate_code 通过 extra 发送进度通知', async () => {
    const notifications = [];
    const fakeExtra = {
        sendNotification: async (notif) => { notifications.push(notif); }
    };
    const handler = createLocateCodeHandler({ defaultProjectRoot: PROJECT_ROOT });
    await handler({
        keywords: ['routeTaskByContext'],
        max_hits_per_keyword: 1
    }, fakeExtra);
    // 应至少发「正在搜索」和「搜索完成」两条
    assert.ok(notifications.length >= 2, `应至少发 2 条通知，实际 ${notifications.length}`);
    assert.match(notifications[0].params.data, /正在搜索/);
    assert.match(notifications[notifications.length - 1].params.data, /搜索完成/);
});

// ---------- P2-4: search_history 工具 ----------

test('P2-4: search_history 调 bridge /history 端点返回结果', async () => {
    // 启动 bridge 子进程用于测试
    const { spawn } = await import('node:child_process');
    const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
    const PORT = 18802;
    const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, LISTEN_PORT: String(PORT), USAGE_LOG: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
        // 等 bridge 起来
        await new Promise((resolve, reject) => {
            let attempts = 0;
            const timer = setInterval(() => {
                attempts++;
                const http = require('http');
                const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
                    res.resume();
                    if (res.statusCode === 200) { clearInterval(timer); resolve(); }
                });
                req.on('error', () => { if (attempts > 60) { clearInterval(timer); reject(new Error('bridge 启动失败')); } });
            }, 100);
        });

        const notifications = [];
        const fakeExtra = {
            sendNotification: async (notif) => { notifications.push(notif); }
        };
        const handler = createSearchHistoryHandler({ bridgeBaseUrl: `http://127.0.0.1:${PORT}` });
        const result = await handler({
            limit: 5
        }, fakeExtra);

        assert.ok(!result.isError, 'search_history 不应报错');
        const body = JSON.parse(result.content[0].text);
        assert.ok(body.ok === true, '响应应 ok=true');
        assert.equal(typeof body.total, 'number');
        assert.equal(typeof body.returned, 'number');
        assert.ok(Array.isArray(body.results));
        assert.ok(body.results.length <= 5, '应返回最多 5 条');
        assert.ok(notifications.length >= 2, '应至少发 2 条进度通知');
        assert.match(notifications[0].params.data, /正在搜索/);
    } finally {
        try { child.kill('SIGKILL'); } catch {}
    }
});

test('P2-4: search_history 带 task 过滤参数', async () => {
    const { spawn } = await import('node:child_process');
    const BRIDGE_SCRIPT = path.join(PROJECT_ROOT, 'zhipu-bridge-api.js');
    const PORT = 18803;
    const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, LISTEN_PORT: String(PORT), USAGE_LOG: '0' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
        await new Promise((resolve, reject) => {
            let attempts = 0;
            const timer = setInterval(() => {
                attempts++;
                const http = require('http');
                const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
                    res.resume();
                    if (res.statusCode === 200) { clearInterval(timer); resolve(); }
                });
                req.on('error', () => { if (attempts > 60) { clearInterval(timer); reject(new Error('bridge 启动失败')); } });
            }, 100);
        });

        const handler = createSearchHistoryHandler({ bridgeBaseUrl: `http://127.0.0.1:${PORT}` });
        const result = await handler({ task: 'error', limit: 10 }, {});
        assert.ok(!result.isError);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.query.task, 'error');
        for (const r of body.results) {
            assert.equal(r.task, 'error', '所有结果 task 应为 error');
        }
    } finally {
        try { child.kill('SIGKILL'); } catch {}
    }
});
