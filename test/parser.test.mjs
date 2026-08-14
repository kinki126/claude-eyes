// ============================================================
// parser.test.mjs —— extractAnalysis 健壮 JSON 解析单测（离线，无需 API key）
// 运行：node --test test/  （或 npm test）
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractAnalysis } = require('../zhipu-bridge-api.js');

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
