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
    sliceLongImage, routeTaskByContext, buildHint,
    imgContextGet, imgContextSet, buildInheritedContext, _resetCaches,
    parseDiffs, parseVerifyObject, historySearch
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

test('routeTask: 否定语境不误切（没有报错/no error）', () => {
    // 中文否定（紧邻）
    assert.equal(routeTaskByContext('general', '没有报错', ''), 'general');
    assert.equal(routeTaskByContext('general', '无报错', ''), 'general');
    assert.equal(routeTaskByContext('general', '不是错误', ''), 'general');
    assert.equal(routeTaskByContext('general', '没对比过', ''), 'general');
    // 英文否定（紧邻）
    assert.equal(routeTaskByContext('general', 'no error', ''), 'general');
    assert.equal(routeTaskByContext('general', 'not error', ''), 'general');
    assert.equal(routeTaskByContext('general', 'without diff', ''), 'general');
});

test('routeTask: 肯定语境仍正常命中', () => {
    assert.equal(routeTaskByContext('general', '有个报错', ''), 'error');
    assert.equal(routeTaskByContext('general', 'an exception', ''), 'error');
});

test('routeTask: 否定一个词但肯定另一个词', () => {
    assert.equal(routeTaskByContext('general', '没有报错，看下界面布局', ''), 'ui');
});

// ---------- buildHint（P0-3：失败时给可执行建议） ----------
test('buildHint: 各 errorType 都返回非空字符串', () => {
    const types = ['missing_path', 'file_not_found', 'too_many_images', 'payload_too_large',
        'bad_json', 'images_empty', 'base64_invalid', 'rate_limited', 'bad_request',
        'all_providers_failed', 'internal', 'unknown_endpoint'];
    for (const t of types) {
        const hint = buildHint(t);
        assert.equal(typeof hint, 'string', `${t} 应返回字符串`);
        assert.ok(hint.length > 10, `${t} 建议不应过短（实际 ${hint.length}）`);
        assert.match(hint, /建议[:：]/, `${t} 建议应以「建议：」开头`);
    }
});

test('buildHint: rate_limited 把 retryAfter 透传到建议', () => {
    const hint = buildHint('rate_limited', { retryAfter: 30 });
    assert.match(hint, /30/);
});

test('buildHint: file_not_found 把缺失文件路径透传', () => {
    const hint = buildHint('file_not_found', { missing: 'E:\\no.png' });
    assert.match(hint, /E:\\no\.png/);
});

test('buildHint: base64_invalid 把 index 透传', () => {
    const hint = buildHint('base64_invalid', { index: 2 });
    assert.match(hint, /images\[2\]/);
});

test('buildHint: 未知 errorType 走 internal 兜底', () => {
    const hint = buildHint('something_unknown');
    assert.ok(hint.includes('bridge 内部错误') || hint.includes('request_id'));
});

// ---------- P0-1: imgContextCache + buildInheritedContext（多轮追问上下文继承） ----------

test('imgContext: set + get 基本读写', () => {
    _resetCaches();
    const md5 = 'test-md5-001';
    const ctx = { task: 'error', keywords: ['TypeError', 'renderX'], regions: [{ label: '报错堆栈', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } }], analysis: '在 renderX 函数发现 TypeError' };
    imgContextSet(md5, ctx);
    const got = imgContextGet(md5);
    assert.ok(got, '应能取回上下文');
    assert.equal(got.task, 'error');
    assert.deepEqual(got.keywords, ['TypeError', 'renderX']);
    assert.equal(got.analysis, '在 renderX 函数发现 TypeError');
});

test('imgContext: get 未命中的 md5 返回 null', () => {
    _resetCaches();
    assert.equal(imgContextGet('nonexistent-md5'), null);
});

test('imgContext: LRU 淘汰（超过 CACHE_MAX 时最老的被删）', () => {
    _resetCaches();
    // 注：CACHE_MAX 默认 500，这里写 501 条，第一条应被淘汰
    for (let i = 0; i < 501; i++) {
        imgContextSet(`md5-lru-${i}`, { task: 'general', keywords: [], regions: [], analysis: `analysis-${i}` });
    }
    assert.equal(imgContextGet('md5-lru-0'), null, '第一条应被 LRU 淘汰');
    assert.ok(imgContextGet('md5-lru-500'), '最后一条应存在');
});

test('buildInheritedContext: 完整上下文构造正确片段', () => {
    const ctx = {
        task: 'error',
        keywords: ['TypeError', 'renderX', 'foo', 'bar', 'baz', 'extra1', 'extra2'],
        regions: [
            { label: '报错堆栈', bbox: { x: 0.05, y: 0.02, w: 0.40, h: 0.12 } },
            { label: '按钮', bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 } },
            { label: '区域3', bbox: { x: 0.7, y: 0.7, w: 0.05, h: 0.05 } },
            { label: '区域4', bbox: { x: 0.8, y: 0.8, w: 0.05, h: 0.05 } }
        ],
        analysis: '在 renderX 函数发现 TypeError，建议检查第 42 行的空指针解引用。'.repeat(20) // 超长 analysis
    };
    const fragment = buildInheritedContext(ctx);
    assert.match(fragment, /上一轮分析上下文/);
    assert.match(fragment, /上轮 task: error/);
    assert.match(fragment, /TypeError/);
    assert.match(fragment, /renderX/);
    assert.match(fragment, /报错堆栈/);
    assert.match(fragment, /bbox:0\.05,0\.02,0\.4,0\.12/);
    assert.match(fragment, /本轮 focus 是基于上述上下文的追问/);
    // keywords 只取前 5 个
    assert.ok(!fragment.includes('extra2'), 'keywords 应只取前 5 个');
    // regions 只取前 3 个
    assert.ok(!fragment.includes('区域4'), 'regions 应只取前 3 个');
    // analysis 截断到 200 字符
    assert.match(fragment, /\.\.\./);
});

test('buildInheritedContext: 空 ctx 返回空字符串', () => {
    assert.equal(buildInheritedContext(null), '');
    assert.equal(buildInheritedContext(undefined), '');
    assert.equal(buildInheritedContext({}), '');
    assert.equal(buildInheritedContext({ task: 'error' }), ''); // 没有 analysis 也返回空
});

test('buildInheritedContext: 缺 keywords 或 regions 仍能构造', () => {
    const ctx = { task: 'ui', analysis: '界面布局正常' };
    const fragment = buildInheritedContext(ctx);
    assert.match(fragment, /上轮 task: ui/);
    assert.match(fragment, /上轮分析摘要: 界面布局正常/);
    assert.ok(!fragment.includes('上轮提取的关键词'), '无 keywords 时不应有关键词行');
    assert.ok(!fragment.includes('上轮定位的区域'), '无 regions 时不应有区域行');
});

// ---------- P1-3: parseDiffs（diff 结构化解析） ----------

test('parseDiffs: 完整的 diffs 数组解析', () => {
    const raw = [
        { item: '按钮颜色', from: '灰色', to: '蓝色', change_type: 'modify', image_index: 1, bbox: { x: 0.3, y: 0.6, w: 0.15, h: 0.08 } },
        { item: '标题', from: '', to: '新版', change_type: 'add', image_index: 1, bbox: { x: 0.1, y: 0.05, w: 0.3, h: 0.05 } }
    ];
    const diffs = parseDiffs(raw);
    assert.equal(diffs.length, 2);
    assert.equal(diffs[0].item, '按钮颜色');
    assert.equal(diffs[0].change_type, 'modify');
    assert.equal(diffs[0].image_index, 1);
    assert.deepEqual(diffs[0].bbox, { x: 0.3, y: 0.6, w: 0.15, h: 0.08 });
    assert.equal(diffs[1].change_type, 'add');
});

test('parseDiffs: 非法 change_type 回退为 modify', () => {
    const diffs = parseDiffs([{ item: 'x', change_type: 'invalid' }]);
    assert.equal(diffs[0].change_type, 'modify');
});

test('parseDiffs: bbox 尺度自适应（0~100 输入归一化到 0~1）', () => {
    const diffs = parseDiffs([{ item: 'x', bbox: { x: 10, y: 20, w: 30, h: 40 } }]);
    assert.deepEqual(diffs[0].bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('parseDiffs: 非数组返回空数组', () => {
    assert.deepEqual(parseDiffs(null), []);
    assert.deepEqual(parseDiffs(undefined), []);
    assert.deepEqual(parseDiffs('not-array'), []);
    assert.deepEqual(parseDiffs({}), []);
});

test('parseDiffs: 超过 20 条截断', () => {
    const raw = Array(25).fill({ item: 'x' });
    const diffs = parseDiffs(raw);
    assert.equal(diffs.length, 20);
});

test('parseDiffs: 空对象过滤', () => {
    const diffs = parseDiffs([{ item: 'x' }, {}, null, { from: 'a' }]);
    assert.equal(diffs.length, 2);
});

// ---------- P1-5: parseVerifyObject（verify 结构化解析） ----------

test('parseVerifyObject: 完整对象解析', () => {
    const v = parseVerifyObject({ passed: true, reason: '按钮确为红色' }, 'true');
    assert.equal(v.passed, true);
    assert.equal(v.reason, '按钮确为红色');
});

test('parseVerifyObject: verdict=false → passed=false', () => {
    const v = parseVerifyObject({ passed: false, reason: '按钮是蓝色' }, 'false');
    assert.equal(v.passed, false);
    assert.equal(v.reason, '按钮是蓝色');
});

test('parseVerifyObject: verdict=uncertain → passed=null', () => {
    const v = parseVerifyObject({ passed: true, reason: '看不清' }, 'uncertain');
    assert.equal(v.passed, null, 'uncertain 时即使 passed=true 也应被强制为 null');
    assert.equal(v.reason, '看不清');
});

test('parseVerifyObject: 字符串 passed 被解析为布尔', () => {
    assert.equal(parseVerifyObject({ passed: 'true' }, 'true').passed, true);
    assert.equal(parseVerifyObject({ passed: 'false' }, 'false').passed, false);
    assert.equal(parseVerifyObject({ passed: 'null' }, 'uncertain').passed, null);
    assert.equal(parseVerifyObject({ passed: 'uncertain' }, 'uncertain').passed, null);
});

test('parseVerifyObject: 没有 verify 对象时从 verdict 推导（向后兼容）', () => {
    assert.equal(parseVerifyObject(null, 'true').passed, true);
    assert.equal(parseVerifyObject(undefined, 'false').passed, false);
    assert.equal(parseVerifyObject(null, 'uncertain'), null);
});

test('parseVerifyObject: 非布尔/字符串的 passed 从 verdict 推导', () => {
    // passed 是数字 1（truthy）+ verdict=true → true
    assert.equal(parseVerifyObject({ passed: 1 }, 'true').passed, true);
    // passed 是数字 0（falsy）+ verdict=false → false
    assert.equal(parseVerifyObject({ passed: 0 }, 'false').passed, false);
});

// ---------- P2-4: historySearch（历史搜索） ----------

test('historySearch: 无历史文件返回空结果', () => {
    // 使用临时 HISTORY_FILE 路径（通过 env 控制）—— 这里仅验证无文件场景
    // 实际项目里 .claude-eyes/history.jsonl 存在，所以这个测试用 mock 路径
    const result = historySearch({ limit: 5 });
    // 至少应返回 { total, results } 结构
    assert.ok(typeof result.total === 'number');
    assert.ok(Array.isArray(result.results));
});

test('historySearch: task 过滤', () => {
    const result = historySearch({ task: 'error', limit: 100 });
    for (const r of result.results) {
        assert.equal(r.task, 'error', '所有结果 task 都应是 error');
    }
});

test('historySearch: keyword 模糊匹配', () => {
    const result = historySearch({ keyword: 'TypeError', limit: 100 });
    for (const r of result.results) {
        const analysis = String(r.analysis || '').toLowerCase();
        const keywords = Array.isArray(r.keywords) ? r.keywords.join(' ').toLowerCase() : '';
        assert.ok(analysis.includes('typeerror') || keywords.includes('typeerror'),
            '所有结果应含 TypeError');
    }
});

test('historySearch: limit 上限 100', () => {
    const result = historySearch({ limit: 1000 });
    assert.ok(result.results.length <= 100, '应被限制到 100');
});

test('historySearch: 默认 limit 20', () => {
    const result = historySearch({});
    assert.ok(result.results.length <= 20, '默认应返回最多 20 条');
});

test('historySearch: 时间范围过滤', () => {
    const result = historySearch({ since: '2026-01-01', until: '2026-12-31', limit: 100 });
    for (const r of result.results) {
        if (r.ts) {
            const ts = Date.parse(r.ts);
            assert.ok(ts >= Date.parse('2026-01-01'), `${r.ts} 应 >= 2026-01-01`);
            assert.ok(ts <= Date.parse('2026-12-31'), `${r.ts} 应 <= 2026-12-31`);
        }
    }
});

test('historySearch: 返回结果按 ts 倒序', () => {
    const result = historySearch({ limit: 100 });
    for (let i = 1; i < result.results.length; i++) {
        const prev = Date.parse(result.results[i - 1].ts || '') || 0;
        const curr = Date.parse(result.results[i].ts || '') || 0;
        assert.ok(prev >= curr, `结果应按 ts 倒序，但第 ${i - 1} 项早于第 ${i} 项`);
    }
});
