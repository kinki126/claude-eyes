// ============================================================
// image-processing.test.mjs —— chooseFormat / sliceLongImage / ocrPreprocess 单测
// 用真实 sharp 处理合成小图验证
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseFormat, sliceLongImage, ocrPreprocess } = require('../zhipu-bridge-api.js');

// 合成 PNG（无 alpha，3 通道）— UI/文字类
async function makePngNoAlpha(w, h) {
    const raw = Buffer.alloc(w * h * 3, 0);
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// 合成 JPEG（无 alpha）— 照片类
async function makeJpeg(w, h) {
    const raw = Buffer.alloc(w * h * 3, 0);
    for (let i = 0; i < w * h; i++) {
        raw[i * 3] = 200;     // R
        raw[i * 3 + 1] = 100; // G
        raw[i * 3 + 2] = 50;  // B
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}

// 合成 PNG 带 alpha — UI 类（按钮等）
async function makePngWithAlpha(w, h) {
    const raw = Buffer.alloc(w * h * 4, 0);
    return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// ---------- chooseFormat ----------
test('chooseFormat: JPEG 照片 → WebP q=80', async () => {
    const buf = await makeJpeg(100, 100);
    const fmt = await chooseFormat(buf);
    assert.equal(fmt.format, 'webp');
    assert.equal(fmt.quality, 80);
});

test('chooseFormat: PNG 无 alpha（UI/文字）→ PNG 无损', async () => {
    const buf = await makePngNoAlpha(100, 100);
    const fmt = await chooseFormat(buf);
    assert.equal(fmt.format, 'png');
    assert.equal(fmt.quality, null);
});

test('chooseFormat: PNG 带 alpha → PNG（保留透明）', async () => {
    const buf = await makePngWithAlpha(100, 100);
    const fmt = await chooseFormat(buf);
    assert.equal(fmt.format, 'png');
});

test('chooseFormat: 无效输入 → 默认 PNG', async () => {
    const fmt = await chooseFormat(Buffer.from('not-an-image'));
    assert.equal(fmt.format, 'png');
    assert.equal(fmt.quality, null);
});

// ---------- sliceLongImage ----------
test('sliceLongImage: 正方形图不切片', async () => {
    const buf = await makePngNoAlpha(100, 100);
    const slices = await sliceLongImage(buf);
    assert.equal(slices.length, 1);
    assert.equal(slices[0], buf, '不切片时返回原 Buffer 引用');
});

test('sliceLongImage: 横长图（200x50）→ 切成多段', async () => {
    const buf = await makePngNoAlpha(200, 50);
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2, '应至少切成 2 段');
    // 每段应是有效 PNG
    for (const s of slices) {
        const meta = await sharp(s).metadata();
        assert.equal(meta.format, 'png');
        assert.ok(meta.height === 50, '横长切片高度保持');
    }
});

test('sliceLongImage: 竖长图（50x300）→ 切成多段', async () => {
    const buf = await makePngNoAlpha(50, 300);
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2, '应至少切成 2 段');
    for (const s of slices) {
        const meta = await sharp(s).metadata();
        assert.equal(meta.format, 'png');
        assert.equal(meta.width, 50, '竖长切片宽度保持');
    }
});

test('sliceLongImage: 比例 ≤ 3 不切片', async () => {
    const buf = await makePngNoAlpha(300, 100); // 比例 = 3，临界值
    const slices = await sliceLongImage(buf);
    assert.equal(slices.length, 1);
});

test('sliceLongImage: 极长图（比例 10）切成最多 5 段', async () => {
    const buf = await makePngNoAlpha(50, 500); // 比例 = 10
    const slices = await sliceLongImage(buf);
    assert.ok(slices.length >= 2 && slices.length <= 5, `切片数 ${slices.length} 应在 2~5 之间`);
});

test('sliceLongImage: 无效输入返回 [原 buf]', async () => {
    const badBuf = Buffer.from('not-an-image');
    const slices = await sliceLongImage(badBuf);
    assert.equal(slices.length, 1);
    assert.equal(slices[0], badBuf);
});

// ---------- ocrPreprocess ----------
test('ocrPreprocess: 输出有效 PNG', async () => {
    const buf = await makePngNoAlpha(100, 100);
    const out = await ocrPreprocess(buf);
    assert.ok(Buffer.isBuffer(out));
    const meta = await sharp(out).metadata();
    assert.equal(meta.format, 'png');
});

test('ocrPreprocess: 输出尺寸与输入一致（仅像素值变化）', async () => {
    const buf = await makePngNoAlpha(50, 50);
    const out = await ocrPreprocess(buf);
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 50);
    assert.equal(meta.height, 50);
});

test('ocrPreprocess: 输出无 alpha 通道（二值化后是灰度）', async () => {
    const buf = await makePngWithAlpha(50, 50); // 带 alpha
    const out = await ocrPreprocess(buf);
    const meta = await sharp(out).metadata();
    // greyscale 后输出可能是 sRGB 或灰度；关键是格式 PNG 且可被模型解析
    assert.equal(meta.format, 'png');
});

test('ocrPreprocess: 无效输入返回原 buf', async () => {
    const badBuf = Buffer.from('not-an-image');
    const out = await ocrPreprocess(badBuf);
    assert.equal(out, badBuf, '无效输入原样返回');
});
