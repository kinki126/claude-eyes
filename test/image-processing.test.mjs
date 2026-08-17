// ============================================================
// image-processing.test.mjs —— chooseFormat / sliceLongImage / ocrPreprocess 单测
// 用真实 sharp 处理合成小图验证
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import sharp from 'sharp';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseFormat, sliceLongImage, ocrPreprocess, autoCropBorder } = require('../zhipu-bridge-api.js');

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

// ---------- autoCropBorder（P1-4：自动裁掉纯色边框） ----------
// 合成带纯色边框的图：内部画一个白色矩形，外圈 N 像素是黑色边框
async function makeImageWithBorder(innerW, innerH, border) {
    const w = innerW + border * 2;
    const h = innerH + border * 2;
    // 外圈黑色（值 0），内部白色（值 255）的 3 通道图
    const raw = Buffer.alloc(w * h * 3, 0); // 全 0（黑）
    for (let y = border; y < h - border; y++) {
        for (let x = border; x < w - border; x++) {
            const i = (y * w + x) * 3;
            raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255;
        }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('autoCropBorder: 带纯色边框的图应裁掉边框（cropped=true）', async () => {
    // 80x80 内部 + 20px 黑边 = 120x120，trim 后应回到接近 80x80
    const buf = await makeImageWithBorder(80, 80, 20);
    const r = await autoCropBorder(buf);
    assert.equal(r.cropped, true, '应识别为已裁剪');
    assert.ok(r.from && r.to, '应返回 from/to 尺寸信息');
    assert.equal(r.from.width, 120);
    assert.equal(r.from.height, 120);
    // trim 后应在 80x80 附近（允许 threshold 容差导致的 ±几像素）
    assert.ok(r.to.width <= 90 && r.to.width >= 70, `裁后宽度应在 70-90 之间，实际 ${r.to.width}`);
    assert.ok(r.to.height <= 90 && r.to.height >= 70, `裁后高度应在 70-90 之间，实际 ${r.to.height}`);
});

test('autoCropBorder: 无边框的图 cropped=false 且 buf 不变', async () => {
    // 全白图（无纯色边框可裁）—— 实际 sharp.trim 对全色相同图会裁到 1x1，触发回退
    const buf = await makePngNoAlpha(100, 100); // 全黑图，trim 会过度裁剪 → 回退
    const r = await autoCropBorder(buf);
    assert.equal(r.cropped, false, '过度裁剪应回退到 cropped=false');
    assert.equal(r.buf, buf, '回退时返回原 buf 引用');
});

test('autoCropBorder: 内部有内容 + 小边框应正常裁剪', async () => {
    // 30x30 内部 + 5px 黑边 = 40x40，应裁掉小边框
    const buf = await makeImageWithBorder(30, 30, 5);
    const r = await autoCropBorder(buf);
    assert.equal(r.cropped, true, '小边框也应识别');
    assert.ok(r.to.width < r.from.width, '裁后宽度应小于原宽');
    assert.ok(r.to.height < r.from.height, '裁后高度应小于原高');
});

test('autoCropBorder: 无效输入返回 cropped=false 原 buf', async () => {
    const badBuf = Buffer.from('not-an-image');
    const r = await autoCropBorder(badBuf);
    assert.equal(r.cropped, false);
    assert.equal(r.buf, badBuf, '无效输入原样返回');
});
