// ============================================================
// crop-bbox.test.mjs —— parseCropBbox 单测（离线）
// 覆盖：归一化 0~1 / 0~100 / 0~1000 尺度自适应、越界修正、非法返回 null
// 运行：npm test（node --test 自动拾取 test/ 下所有 *.test.mjs）
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseCropBbox } = require('../zhipu-bridge-api.js');

test('归一化 0~1 直接通过', () => {
    const r = parseCropBbox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(r, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('百分比 0~100 自动归一化', () => {
    const r = parseCropBbox({ x: 10, y: 20, w: 30, h: 40 });
    assert.deepEqual(r, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('千分比 0~1000 自动归一化', () => {
    const r = parseCropBbox({ x: 50, y: 100, w: 200, h: 300 });
    assert.deepEqual(r, { x: 0.05, y: 0.1, w: 0.2, h: 0.3 });
});

test('x+w 越界自动收窄到 1', () => {
    const r = parseCropBbox({ x: 0.8, y: 0.2, w: 0.5, h: 0.3 });
    assert.equal(r.x, 0.8);
    assert.ok(Math.abs(r.w - 0.2) < 1e-9); // 1 - 0.8 = 0.19999... 浮点
});

test('y+h 越界自动收窄到 1', () => {
    const r = parseCropBbox({ x: 0.1, y: 0.7, w: 0.2, h: 0.5 });
    assert.equal(r.y, 0.7);
    assert.ok(Math.abs(r.h - 0.3) < 1e-9);
});

test('负值 clamp 到 0', () => {
    const r = parseCropBbox({ x: -0.1, y: -0.2, w: 0.3, h: 0.4 });
    assert.deepEqual(r, { x: 0, y: 0, w: 0.3, h: 0.4 });
});

test('w/h 为 0 返回 null', () => {
    assert.equal(parseCropBbox({ x: 0.5, y: 0.5, w: 0, h: 0.2 }), null);
    assert.equal(parseCropBbox({ x: 0.5, y: 0.5, w: 0.2, h: 0 }), null);
});

test('非有限值返回 null', () => {
    assert.equal(parseCropBbox({ x: NaN, y: 0.2, w: 0.3, h: 0.4 }), null);
    assert.equal(parseCropBbox({ x: Infinity, y: 0.2, w: 0.3, h: 0.4 }), null);
    assert.equal(parseCropBbox({ x: 'a', y: 0.2, w: 0.3, h: 0.4 }), null);
});

test('缺字段返回 null', () => {
    assert.equal(parseCropBbox({ x: 0.1, y: 0.2, w: 0.3 }), null);
    assert.equal(parseCropBbox({ x: 0.1, y: 0.2, h: 0.4 }), null);
});

test('null / undefined / 非对象返回 null', () => {
    assert.equal(parseCropBbox(null), null);
    assert.equal(parseCropBbox(undefined), null);
    assert.equal(parseCropBbox('not an object'), null);
    assert.equal(parseCropBbox([0.1, 0.2, 0.3, 0.4]), null);
});

test('越界收窄后 w/h ≤ 0 返回 null', () => {
    // x=0.99, w=0.5 → w 收窄到 0.01 > 0，合法
    const ok = parseCropBbox({ x: 0.99, y: 0.5, w: 0.5, h: 0.2 });
    assert.ok(Math.abs(ok.w - 0.01) < 1e-9);
    // x=1.0, w=0.5 → w 收窄到 0，应返回 null
    assert.equal(parseCropBbox({ x: 1.0, y: 0.5, w: 0.5, h: 0.2 }), null);
});
