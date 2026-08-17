// ============================================================
// crop-enlarge.test.mjs —— cropAndEnlarge 单测（离线，真实 sharp 处理）
// 用真实的小 PNG（1x1 / 10x10）做裁剪放大验证
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cropAndEnlarge, parseCropBbox } = require('../zhipu-bridge-api.js');

// 10x10 红色 PNG，足够做裁剪放大测试
async function makeRedPng(w = 10, h = 10) {
    const raw = Buffer.alloc(w * h * 3, 0); // 全 0 = 黑色
    for (let i = 0; i < w * h; i++) {
        raw[i * 3] = 255; // R=255, G=0, B=0 → 红色
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } })
        .toFormat('png')
        .toBuffer();
}

test('cropAndEnlarge: 整图 bbox 输出放大到最小边 800', async () => {
    const rawBuf = await makeRedPng(10, 10);
    const bbox = { x: 0, y: 0, w: 1, h: 1 };
    const out = await cropAndEnlarge(rawBuf, bbox);
    assert.ok(out, '应返回 Buffer');
    const meta = await sharp(out).metadata();
    // fit:inside, withoutEnlargement: false → 放大到 800×800
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
    assert.equal(meta.format, 'png');
});

test('cropAndEnlarge: 半图 bbox 裁剪左上 1/4', async () => {
    const rawBuf = await makeRedPng(20, 20);
    const bbox = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const out = await cropAndEnlarge(rawBuf, bbox);
    assert.ok(out);
    const meta = await sharp(out).metadata();
    // 10×10 → 放大到 800×800
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
});

test('cropAndEnlarge: bbox 越界自动收窄', async () => {
    const rawBuf = await makeRedPng(20, 20);
    // x=0.9, w=0.5 → 实际 pxW = 10，但 left=18，超出 20 → 收窄到 2
    const bbox = { x: 0.9, y: 0.9, w: 0.5, h: 0.5 };
    const out = await cropAndEnlarge(rawBuf, bbox);
    assert.ok(out, '越界收窄后应仍能输出');
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
});

test('cropAndEnlarge: 整图 1x1 也能放大', async () => {
    const rawBuf = await makeRedPng(1, 1);
    const out = await cropAndEnlarge(rawBuf, { x: 0, y: 0, w: 1, h: 1 });
    assert.ok(out);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 800);
    assert.equal(meta.height, 800);
});

test('cropAndEnlarge: 无效输入返回 null', async () => {
    // 不是合法 PNG
    const out = await cropAndEnlarge(Buffer.from('not-an-image'), { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(out, null);
});

test('cropAndEnlarge: bbox 0 宽度（边界）', async () => {
    const rawBuf = await makeRedPng(20, 20);
    // w=0 → pxW = 0，Math.max(1, 0) = 1，应能输出
    const out = await cropAndEnlarge(rawBuf, { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 });
    // pxW=1, pxH=1，cropAndEnlarge 应能处理
    assert.ok(out !== null);
});

// parseCropBbox 与 cropAndEnlarge 联动
test('parseCropBbox → cropAndEnlarge: 0~1 输入正常裁剪', async () => {
    const rawBuf = await makeRedPng(20, 20);
    const bbox = parseCropBbox({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    assert.deepEqual(bbox, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const out = await cropAndEnlarge(rawBuf, bbox);
    assert.ok(out);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 800);
});

test('parseCropBbox → cropAndEnlarge: 0~100 输入自动归一化后裁剪', async () => {
    const rawBuf = await makeRedPng(20, 20);
    const bbox = parseCropBbox({ x: 25, y: 25, w: 50, h: 50 });
    assert.deepEqual(bbox, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const out = await cropAndEnlarge(rawBuf, bbox);
    assert.ok(out);
});
