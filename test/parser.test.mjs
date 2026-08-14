// ============================================================
// parser.test.mjs —— extractAnalysis 健壮 JSON 解析单测（离线，无需 API key）
// 运行：node --test test/  （或 npm test）
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractAnalysis, buildPrompt } = require('../zhipu-bridge-api.js');

test('普通 JSON → stop', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: '报错X', next_action: 'stop', reason: '完成' }));
    assert.equal(r.action, 'stop');
    assert.equal(r.status, 'ok');
    assert.equal(r.analysis, '报错X');
    assert.equal(r.reason, '完成');
});

test('围栏 json 代码块 → continue', () => {
    const input = '分析结果：\n```json\n{"analysis":"报错Y","next_action":"continue","reason":"还有下一张"}\n```\n完毕';
    const r = extractAnalysis(input);
    assert.equal(r.action, 'continue');
    assert.equal(r.status, 'ok');
    assert.equal(r.analysis, '报错Y');
});

test('散文包裹 → stop', () => {
    const input = '好的，我已经分析完了，结果如下：{"analysis":"报错Z","next_action":"stop","reason":"已定位"} 希望对你有帮助。';
    const r = extractAnalysis(input);
    assert.equal(r.action, 'stop');
    assert.equal(r.status, 'ok');
    assert.equal(r.analysis, '报错Z');
});

test('二次编码(JSON 字符串套字符串) → continue', () => {
    const inner = JSON.stringify({ analysis: '报错W', next_action: 'continue', reason: '继续' });
    const input = JSON.stringify(inner);
    const r = extractAnalysis(input);
    assert.equal(r.action, 'continue');
    assert.equal(r.status, 'ok');
    assert.equal(r.analysis, '报错W');
});

test('单键包裹 {"result":"{...}"} → stop', () => {
    const input = JSON.stringify({ result: JSON.stringify({ analysis: '报错V', next_action: 'stop', reason: '完' }) });
    const r = extractAnalysis(input);
    assert.equal(r.action, 'stop');
    assert.equal(r.analysis, '报错V');
});

test('内容数组 [{type:text,text}] → continue', () => {
    const input = [{ type: 'text', text: JSON.stringify({ analysis: '数组形态', next_action: 'continue', reason: '数组' }) }];
    const r = extractAnalysis(input);
    assert.equal(r.action, 'continue');
    assert.equal(r.analysis, '数组形态');
});

test('垃圾输入 → 安全默认 continue + failed', () => {
    const r = extractAnalysis('抱歉，我无法识别这张图片的内容。');
    assert.equal(r.action, 'continue'); // 解析失败默认 continue，避免误终止流程
    assert.equal(r.status, 'failed');
});

test('空/undefined 输入 → failed 且不抛异常', () => {
    const r = extractAnalysis('');
    assert.equal(r.status, 'failed');
    assert.equal(r.action, 'continue');
    const r2 = extractAnalysis(null);
    assert.equal(r2.status, 'failed');
});

test('带 keywords 的 JSON → 解析出关键词数组', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: '报错', keywords: ['handleClick', 'api/user', 'ERR_401'], next_action: 'continue', reason: 'r' }));
    assert.deepEqual(r.keywords, ['handleClick', 'api/user', 'ERR_401']);
    assert.equal(r.status, 'ok');
});

test('无 keywords → 空数组', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: 'x', next_action: 'stop' }));
    assert.deepEqual(r.keywords, []);
});

test('垃圾输入 → keywords 空数组', () => {
    const r = extractAnalysis('无法识别');
    assert.deepEqual(r.keywords, []);
});

test('带 annotated_text 的 JSON → 转录出标注文字', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: '红框内是报错', annotated_text: 'TypeError: Cannot read property of null', next_action: 'continue', reason: 'r' }));
    assert.equal(r.annotatedText, 'TypeError: Cannot read property of null');
    assert.equal(r.status, 'ok');
});

test('无 annotated_text → 空字符串', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: 'x', next_action: 'stop' }));
    assert.equal(r.annotatedText, '');
});

test('buildPrompt 注入 focus：最高优先级定向指令', () => {
    const p = buildPrompt('error', 'zh', '', '左上角红框里的报错文字');
    assert.ok(p.includes('左上角红框里的报错文字'));
    assert.ok(p.includes('重点关注区域/问题'));
    // 无 focus 时不注入定向指令
    const p2 = buildPrompt('general', 'zh', '', '');
    assert.ok(!p2.includes('重点关注区域/问题'));
    // 有 desc 时 desc 与 focus 并存
    const p3 = buildPrompt('general', 'zh', '用户说看看按钮', '第 3 个按钮的文案');
    assert.ok(p3.includes('用户说看看按钮'));
    assert.ok(p3.includes('第 3 个按钮的文案'));
});

test('带 regions 的 JSON → 解析出归一化 bbox', () => {
    const r = extractAnalysis(JSON.stringify({
        analysis: '红框内报错',
        regions: [{ label: '框选', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, text: 'TypeError', note: '红框' }],
        next_action: 'continue'
    }));
    assert.equal(r.status, 'ok');
    assert.equal(r.regions.length, 1);
    assert.deepEqual(r.regions[0].bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
    assert.equal(r.regions[0].label, '框选');
    assert.equal(r.regions[0].text, 'TypeError');
});

test('regions 坐标尺度自适应（0~1000 → 归一化）', () => {
    const r = extractAnalysis(JSON.stringify({
        analysis: 'x',
        regions: [{ label: '报错', bbox: { x: 100, y: 200, w: 300, h: 100 } }],
        next_action: 'stop'
    }));
    assert.deepEqual(r.regions[0].bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.1 });
});

test('无 regions / 坏 regions → 空数组或 bbox=null 且不抛异常', () => {
    assert.deepEqual(extractAnalysis(JSON.stringify({ analysis: 'x', next_action: 'stop' })).regions, []);
    assert.deepEqual(extractAnalysis('无法识别').regions, []);
    const bad = extractAnalysis(JSON.stringify({ analysis: 'x', regions: [{ label: '空' }], next_action: 'stop' }));
    assert.deepEqual(bad.regions, [{ label: '空', bbox: null, text: '', note: '' }]);
});

test('带 verbatim 的 JSON → 转录出原文', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: '报错', verbatim: 'TypeError: x is not a function\n  at foo (a.js:1:2)', next_action: 'continue' }));
    assert.equal(r.verbatim, 'TypeError: x is not a function\n  at foo (a.js:1:2)');
    assert.equal(r.status, 'ok');
});

test('无 verbatim → 空字符串', () => {
    assert.equal(extractAnalysis(JSON.stringify({ analysis: 'x', next_action: 'stop' })).verbatim, '');
    assert.equal(extractAnalysis('无法识别').verbatim, '');
});

test('带 verdict 的 JSON → 解析核验结果', () => {
    const r = extractAnalysis(JSON.stringify({ verdict: 'true', evidence: '第3行是 TypeError', analysis: '成立', next_action: 'stop' }));
    assert.equal(r.verdict, 'true');
    assert.equal(r.evidence, '第3行是 TypeError');
    // 非法 verdict → null
    const r2 = extractAnalysis(JSON.stringify({ verdict: 'maybe', analysis: 'x' }));
    assert.equal(r2.verdict, null);
});

test('无 verdict → null；无 evidence → 空字符串', () => {
    const r = extractAnalysis(JSON.stringify({ analysis: 'x', next_action: 'stop' }));
    assert.equal(r.verdict, null);
    assert.equal(r.evidence, '');
    assert.equal(extractAnalysis('无法识别').verdict, null);
});

test('buildPrompt verify 任务 → 注入断言并要求 verdict，不叠加通用 tail', () => {
    const p = buildPrompt('verify', 'zh', '报错是 TypeError');
    assert.ok(p.includes('报错是 TypeError'));
    assert.ok(p.includes('verdict'));
    assert.ok(p.includes('true 或 false 或 uncertain'));
    assert.ok(!p.includes('annotated_text'));
});
