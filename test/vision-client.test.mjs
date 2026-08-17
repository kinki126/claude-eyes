// ============================================================
// vision-client.test.mjs —— 熔断状态机 + provider failover 单测（离线）
// 不调真实 HTTP：用 mock axios 实例控制每次调用的成功/失败
// 覆盖：
//   - isTransientError 分类
//   - markSuccess/markFailure/isCircuitOpen 状态流转
//   - 连续 3 次失败触发熔断 → 熔断期内跳过 → 5 分钟后放试探
//   - 主失败自动切备选 provider
//   - 非瞬时错误（400）不重试直接切
//   - 重试 2 次仍失败才切下一个
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    isTransientError,
    markSuccess, markFailure, isCircuitOpen,
    _resetCircuit, _FAILURE_THRESHOLD,
    analyzeImage, loadConfig
} = require('../vision-client.js');

// ---------- isTransientError ----------
test('isTransientError: 429 限流是瞬时', () => {
    assert.equal(isTransientError({ code: 'ERR' }, 429), true);
});
test('isTransientError: 500 服务端错误是瞬时', () => {
    assert.equal(isTransientError({ code: 'ERR' }, 502), true);
    assert.equal(isTransientError({ code: 'ERR' }, 599), true);
});
test('isTransientError: 400 客户端错误不是瞬时', () => {
    assert.equal(isTransientError({ code: 'ERR' }, 400), false);
    assert.equal(isTransientError({ code: 'ERR' }, 404), false);
});
test('isTransientError: 网络错误码是瞬时', () => {
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']) {
        assert.equal(isTransientError({ code }, undefined), true);
    }
});
test('isTransientError: 无 err 返回 false', () => {
    assert.equal(isTransientError(null, 500), false);
});

// ---------- 熔断状态机 ----------
test('熔断状态机：单次失败不熔断', () => {
    _resetCircuit();
    markFailure('p1');
    assert.equal(isCircuitOpen('p1'), false);
});

test('熔断状态机：连续 3 次失败触发熔断', () => {
    _resetCircuit();
    const name = `p2-${Date.now()}-${Math.random()}`;
    markFailure(name);
    markFailure(name);
    assert.equal(isCircuitOpen(name), false);
    markFailure(name); // 第 3 次
    assert.equal(isCircuitOpen(name), true);
});

test('熔断状态机：markSuccess 清零失败计数', () => {
    _resetCircuit();
    markFailure('p3');
    markFailure('p3');
    markSuccess('p3');
    // 失败计数清零，再失败 2 次不应熔断
    markFailure('p3');
    markFailure('p3');
    assert.equal(isCircuitOpen('p3'), false);
});

test('熔断状态机：5 分钟后放试探（mock 时间）', () => {
    _resetCircuit();
    // 用直接操作内部 Map 模拟"时间已过"
    const CIRCUIT = require('../vision-client.js')._CIRCUIT;
    CIRCUIT.set('p4', { failures: 3, openUntil: Date.now() - 1000 }); // 1 秒前就到期
    // 现在调 isCircuitOpen 应返回 false（窗口到期）并清掉状态
    assert.equal(isCircuitOpen('p4'), false);
    // 状态被清零
    assert.equal(CIRCUIT.has('p4'), false);
});

test('熔断状态机：FAILURE_THRESHOLD = 3', () => {
    assert.equal(_FAILURE_THRESHOLD, 3);
});

// ---------- helper: 构造 mock axios ----------
function mockAxios(responses) {
    // responses: [{ throw?: Error, response?: any, status?: number }]
    // 每次 post 弹一个；用闭包保存计数
    let i = 0;
    return {
        post: async () => {
            const r = responses[i++] || responses[responses.length - 1];
            if (r.throw) {
                const err = r.throw;
                if (r.status) {
                    err.response = { status: r.status, data: { error: { message: 'mock' } } };
                }
                throw err;
            }
            return { data: r.response };
        }
    };
}

function mockTransientErr(code = 'ETIMEDOUT') {
    const e = new Error('mock transient');
    e.code = code;
    return e;
}

function mockNonTransientErr(status = 400) {
    const e = new Error('mock non-transient');
    return e; // 在 mockAxios 里给它挂 response.status
}

// ---------- analyzeImage failover ----------
test('failover: 主成功 → 不切备选', async () => {
    _resetCircuit();
    let calls = 0;
    const http = {
        post: async () => {
            calls++;
            return { data: { choices: [{ message: { content: '{"analysis":"ok"}' } }] } };
        }
    };
    const r = await analyzeImage({
        base64Images: ['iVBORw0KGgo='],
        prompt: 'test',
        axiosInstance: http
    });
    assert.equal(calls, 1);
    assert.equal(r.content, '{"analysis":"ok"}');
});

test('failover: 连续 3 次 analyzeImage 调用都失败 → primary 被熔断', async () => {
    _resetCircuit();
    const prevKey2 = process.env.VISION_API_KEY_2;
    delete process.env.VISION_API_KEY_2;
    const http = mockAxios([
        { throw: mockTransientErr('ETIMEDOUT') },
        { throw: mockTransientErr('ETIMEDOUT') },
        { throw: mockTransientErr('ETIMEDOUT') }
    ]);
    await assert.rejects(analyzeImage({ base64Images: ['iVBORw0KGgo='], prompt: 'test', axiosInstance: http }), /所有视觉提供商均调用失败/);
    assert.equal(isCircuitOpen('primary'), false, '第 1 次失败，未到阈值');

    await assert.rejects(analyzeImage({ base64Images: ['iVBORw0KGgo='], prompt: 'test', axiosInstance: http }), /所有视觉提供商均调用失败/);
    assert.equal(isCircuitOpen('primary'), false, '第 2 次失败，未到阈值');

    await assert.rejects(analyzeImage({ base64Images: ['iVBORw0KGgo='], prompt: 'test', axiosInstance: http }), /所有视觉提供商均调用失败/);
    assert.equal(isCircuitOpen('primary'), true, '第 3 次失败，应触发熔断');
    if (prevKey2 !== undefined) process.env.VISION_API_KEY_2 = prevKey2;
});

test('failover: 非瞬时错误不重试，直接切下一个 provider', async () => {
    _resetCircuit();
    let callIdx = 0;
    const http = {
        post: async (url) => {
            callIdx++;
            if (callIdx === 1) {
                // 主 provider 抛 400
                const e = new Error('400');
                e.response = { status: 400, data: { error: { message: 'bad request' } } };
                throw e;
            }
            // 备选 provider 成功
            return { data: { choices: [{ message: { content: '{"analysis":"from-backup"}' } }] } };
        }
    };
    // 需要 env 配置 VISION_API_KEY_2 才会有备选 provider
    const prevKey2 = process.env.VISION_API_KEY_2;
    process.env.VISION_API_KEY_2 = 'test-backup-key';
    try {
        const r = await analyzeImage({
            base64Images: ['iVBORw0KGgo='],
            prompt: 'test',
            axiosInstance: http
        });
        assert.equal(r.content, '{"analysis":"from-backup"}');
        assert.equal(r.provider, 'backup-env');
        assert.equal(callIdx, 2); // 主 1 次（不重试）+ 备 1 次
    } finally {
        if (prevKey2 === undefined) delete process.env.VISION_API_KEY_2;
        else process.env.VISION_API_KEY_2 = prevKey2;
    }
});

test('failover: 主瞬时失败重试 2 次后成功 → 不切备选', async () => {
    _resetCircuit();
    let callIdx = 0;
    const http = {
        post: async () => {
            callIdx++;
            if (callIdx <= 2) throw mockTransientErr('ETIMEDOUT');
            return { data: { choices: [{ message: { content: '{"analysis":"ok-after-retry"}' } }] } };
        }
    };
    const r = await analyzeImage({
        base64Images: ['iVBORw0KGgo='],
        prompt: 'test',
        axiosInstance: http
    });
    assert.equal(r.content, '{"analysis":"ok-after-retry"}');
    assert.equal(callIdx, 3); // attempt 0,1,2 → 第 3 次成功
    // 成功清零失败计数
    assert.equal(isCircuitOpen('primary'), false);
});

test('failover: 熔断中的 provider 直接跳过', async () => {
    _resetCircuit();
    // 手动把 primary 熔断
    const CIRCUIT = require('../vision-client.js')._CIRCUIT;
    CIRCUIT.set('primary', { failures: 3, openUntil: Date.now() + 60000 });
    let calledPrimary = false;
    let calledBackup = false;
    const http = {
        post: async (url) => {
            if (url.includes('bigmodel')) { calledPrimary = true; }
            else { calledBackup = true; }
            return { data: { choices: [{ message: { content: '{"analysis":"from-backup"}' } }] } };
        }
    };
    const prevKey2 = process.env.VISION_API_KEY_2;
    process.env.VISION_API_KEY_2 = 'test-backup-key';
    try {
        const r = await analyzeImage({
            base64Images: ['iVBORw0KGgo='],
            prompt: 'test',
            axiosInstance: http
        });
        assert.equal(r.provider, 'backup-env');
        assert.equal(calledPrimary, false); // primary 被熔断跳过
        assert.equal(calledBackup, true);
    } finally {
        if (prevKey2 === undefined) delete process.env.VISION_API_KEY_2;
        else process.env.VISION_API_KEY_2 = prevKey2;
    }
});

test('failover: 所有 provider 都失败 → 抛"所有视觉提供商均调用失败"', async () => {
    _resetCircuit();
    const http = {
        post: async () => { throw mockTransientErr('ETIMEDOUT'); }
    };
    await assert.rejects(
        analyzeImage({ base64Images: ['iVBORw0KGgo='], prompt: 'test', axiosInstance: http }),
        /所有视觉提供商均调用失败/
    );
});

test('failover: 无图片抛"没有可分析的图片"', async () => {
    _resetCircuit();
    await assert.rejects(
        analyzeImage({ base64Images: [], prompt: 'test', axiosInstance: {} }),
        /没有可分析的图片/
    );
});

test('failover: providerErrors 附在抛出的 Error 上', async () => {
    _resetCircuit();
    const http = {
        post: async () => {
            const e = new Error('400');
            e.response = { status: 400, data: { error: { message: 'bad' } } };
            throw e;
        }
    };
    try {
        await analyzeImage({ base64Images: ['iVBORw0KGgo='], prompt: 'test', axiosInstance: http });
        assert.fail('应抛错');
    } catch (e) {
        assert.ok(Array.isArray(e.providerErrors));
        assert.match(e.providerErrors[0], /primary: HTTP 400/);
    }
});

// ---------- loadConfig ----------
test('loadConfig: 默认含 primary provider', () => {
    const providers = loadConfig();
    assert.ok(providers.length >= 1);
    assert.equal(providers[0].name, 'primary');
    assert.ok(providers[0].base_url);
    assert.ok(providers[0].model);
});

test('loadConfig: VISION_API_KEY_2 加备选', () => {
    const prev = process.env.VISION_API_KEY_2;
    process.env.VISION_API_KEY_2 = 'test';
    try {
        const providers = loadConfig();
        const backup = providers.find(p => p.name === 'backup-env');
        assert.ok(backup, '应有 backup-env');
        assert.equal(backup.api_key, 'test');
    } finally {
        if (prev === undefined) delete process.env.VISION_API_KEY_2;
        else process.env.VISION_API_KEY_2 = prev;
    }
});
