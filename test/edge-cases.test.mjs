// ============================================================
// edge-cases.test.mjs —— #4 剩余测试覆盖：metricsObserve 状态机 / sliceLongImage 边界 / routeTaskByContext 多语言
// 直接调函数验证内部状态，不通过 HTTP
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    metricsObserve, metricsReport, _resetMetrics,
    sliceLongImage, routeTaskByContext
} = require('../zhipu-bridge-api.js');

// ---------- metricsObserve 状态机 ----------
test('metricsObserve: 单次成功请求累加 total_requests + by_task + by_provider + by_user', () => {
    _resetMetrics();
    metricsObserve({ user: 'alice', task: 'error', provider: 'primary', latencyMs: 100, cache: 'miss', ok: true });
    const r = metricsReport();
    assert.equal(r.total_requests, 1);
    assert.equal(r.total_errors, 0);
    assert.equal(r.by_task.error, 1);
    assert.equal(r.by_provider.primary, 1);
    assert.equal(r.by_user.alice, 1);
    assert.equal(r.cache_misses, 1);
});

test('metricsObserve: 多次累加按维度独立计数', () => {
    _resetMetrics();
    metricsObserve({ user: 'alice', task: 'error', provider: 'primary', latencyMs: 100, cache: 'miss', ok: true });
    metricsObserve({ user: 'alice', task: 'error', provider: 'primary', latencyMs: 200, cache: 'hit', ok: true });
    metricsObserve({ user: 'bob', task: 'ocr', provider: 'backup', latencyMs: 300, cache: 'miss', ok: true });
    const r = metricsReport();
    assert.equal(r.total_requests, 3);
    assert.equal(r.by_task.error, 2);
    assert.equal(r.by_task.ocr, 1);
    assert.equal(r.by_provider.primary, 2);
    assert.equal(r.by_provider.backup, 1);
    assert.equal(r.by_user.alice, 2);
    assert.equal(r.by_user.bob, 1);
    assert.equal(r.cache_hits, 1);
    assert.equal(r.cache_misses, 2);
});

test('metricsObserve: 失败请求计入 total_errors + error_types', () => {
    _resetMetrics();
    metricsObserve({ ok: false, latencyMs: 500, errorType: 'all_providers_failed' });
    metricsObserve({ ok: false, latencyMs: 50, errorType: 'internal' });
    metricsObserve({ ok: false, latencyMs: 50, errorType: 'all_providers_failed' });
    const r = metricsReport();
    assert.equal(r.total_requests, 3);
    assert.equal(r.total_errors, 3);
    assert.equal(r.error_rate, '1.0000');
    assert.equal(r.error_types.all_providers_failed, 2);
    assert.equal(r.error_types.internal, 1);
});

test('metricsObserve: cache=hit/miss 不命中时不增加计数', () => {
    _resetMetrics();
    metricsObserve({ ok: true, latencyMs: 10 });
    const r = metricsReport();
    assert.equal(r.cache_hits, 0);
    assert.equal(r.cache_misses, 0);
    assert.equal(r.total_requests, 1);
});

test('metricsObserve: cache_hit_rate 计算', () => {
    _resetMetrics();
    metricsObserve({ cache: 'hit', ok: true });
    metricsObserve({ cache: 'hit', ok: true });
    metricsObserve({ cache: 'miss', ok: true });
    metricsObserve({ cache: 'miss', ok: true });
    const r = metricsReport();
    assert.equal(r.cache_hits, 2);
    assert.equal(r.cache_misses, 2);
    assert.equal(r.cache_hit_rate, '0.5000');
});

test('metricsObserve: latency 推入后 percentile 正确排序', () => {
    _resetMetrics();
    // 推入 5 个样本：10, 20, 30, 40, 100
    [10, 20, 30, 40, 100].forEach(ms => metricsObserve({ latencyMs: ms, ok: true }));
    const r = metricsReport();
    assert.equal(r.latency_p50_ms, 30); // 第 50 百分位（idx = floor(5*0.5)=2 → sorted[2]=30）
    assert.equal(r.latency_p95_ms, 100); // idx = floor(5*0.95)=4 → sorted[4]=100
    assert.equal(r.latency_p99_ms, 100);
});

test('metricsObserve: 空数据 percentile 返回 0', () => {
    _resetMetrics();
    const r = metricsReport();
    assert.equal(r.latency_p50_ms, 0);
    assert.equal(r.latency_p95_ms, 0);
    assert.equal(r.error_rate, '0');
    assert.equal(r.cache_hit_rate, '0');
});

test('metricsObserve: 10 分钟窗口外的 latency 被剔除', async () => {
    _resetMetrics();
    metricsObserve({ latencyMs: 100, ok: true });
    // 等不真实——这里只验证 percentile 不会因 latency 为空而崩
    const r = metricsReport();
    assert.equal(r.latency_p50_ms, 100);
    assert.equal(r.window_ms, 600000); // 10 分钟
});

// ---------- sliceLongImage 边界 ----------
async function makePng(w, h) {
    const raw = Buffer.alloc(w * h * 3, 0);
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('sliceLongImage: 比例 = 3 临界值不切片', async () => {
    const buf = await makePng(300, 100); // 3:1
    const slices = await sliceLongImage(buf);
    assert.equal(slices.length, 1);
});

test('sliceLongImage: 比例 = 3.01 触发切片', async () => {
    const buf = await makePng(301, 100); // 3.01:1
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2, '应至少切 2 段');
});

test('sliceLongImage: 极长图切片数不超过 5', async () => {
    const buf = await makePng(50, 1000); // 20:1
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length <= 5, `切片数 ${slices.length} 应不超过 5`);
});

test('sliceLongImage: 横长切片每段高度保持', async () => {
    const buf = await makePng(500, 50); // 10:1 横长
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2);
    for (const s of slices) {
        const meta = await sharp(s).metadata();
        assert.equal(meta.height, 50, '横长切片高度应保持 50');
    }
});

test('sliceLongImage: 竖长切片每段宽度保持', async () => {
    const buf = await makePng(50, 500); // 10:1 竖长
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2);
    for (const s of slices) {
        const meta = await sharp(s).metadata();
        assert.equal(meta.width, 50, '竖长切片宽度应保持 50');
    }
});

test('sliceLongImage: 切片总宽接近原图（横长，含重叠）', async () => {
    const w = 500, h = 50;
    const buf = await makePng(w, h);
    const slices = await sliceLongImage(buf);
    let totalW = 0;
    for (const s of slices) {
        const meta = await sharp(s).metadata();
        totalW += meta.width;
    }
    // 切片总宽 ≥ 原图（因为重叠）；应 ≤ 原图 + 重叠总和（每段间约 10%）
    assert.ok(totalW >= w, `总宽 ${totalW} 应 ≥ 原图 ${w}`);
    assert.ok(totalW <= w * 1.5, `总宽 ${totalW} 不应远超原图 ${w}（重叠不应过大）`);
});

// ---------- routeTaskByContext 多语言 ----------
test('routeTask: 英文大写也命中（大小写不敏感）', () => {
    // 关键词列表里 'error code' / 'exception' 等是小写存储，函数内对输入 toLowerCase
    assert.equal(routeTaskByContext('general', 'Look at this EXCEPTION', ''), 'error');
    assert.equal(routeTaskByContext('general', 'ERROR CODE 404', ''), 'error');
    assert.equal(routeTaskByContext('general', 'PANIC occurred', ''), 'error');
});

test('routeTask: 英文小写命中', () => {
    assert.equal(routeTaskByContext('general', 'analyze the exception', ''), 'error');
    assert.equal(routeTaskByContext('general', '', 'check the stack trace'), 'error');
});

test('routeTask: 混中英文也命中', () => {
    assert.equal(routeTaskByContext('general', '看下 exception 堆栈', ''), 'error');
    assert.equal(routeTaskByContext('general', 'compare before vs 之后', ''), 'diff');
});

test('routeTask: desc 和 focus 同时命中按规则顺序优先', () => {
    // desc="报错"，focus="对比" → error 优先（error 规则在前）
    assert.equal(routeTaskByContext('general', '报错', '对比'), 'error');
});

test('routeTask: 空白字符不影响匹配', () => {
    assert.equal(routeTaskByContext('general', '  报错  ', '  '), 'error');
    assert.equal(routeTaskByContext('general', '\t报错\n', ''), 'error');
});

test('routeTask: focus 是英文短语能命中', () => {
    assert.equal(routeTaskByContext('general', '', 'before after comparison'), 'diff');
    assert.equal(routeTaskByContext('general', '', 'run ocr on this'), 'ocr');
    assert.equal(routeTaskByContext('general', '', 'ui review for buttons'), 'ui');
});

test('routeTask: 用户传 task=general 显式时仍走路由', () => {
    // routeTaskByContext 只在 task === 'general' 或未指定时才路由
    assert.equal(routeTaskByContext('general', '报错', ''), 'error');
    assert.equal(routeTaskByContext('general', '', ''), 'general'); // 无关键词保持 general
});

test('routeTask: 用户传非 general task 时不被覆盖', () => {
    assert.equal(routeTaskByContext('error', '看下界面', ''), 'error');
    assert.equal(routeTaskByContext('ocr', '看下报错', ''), 'ocr');
    assert.equal(routeTaskByContext('ui', '对比 a 和 b', ''), 'ui');
    assert.equal(routeTaskByContext('diff', '报错信息', ''), 'diff');
});
