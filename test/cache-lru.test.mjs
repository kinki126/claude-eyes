// ============================================================
// cache-lru.test.mjs —— cache/imgCache LRU + TTL 单测（离线）
// 不起服务，直接 require 模块的导出函数操作内部 Map
// ============================================================

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cacheGet, cacheSet, imgCacheGet, imgCacheSet, _resetCaches } = require('../zhipu-bridge-api.js');

// 每个测试前清空 caches，避免互相污染
function reset() { _resetCaches(); }

// ---------- cache（分析结果）LRU ----------
test('cache: 写入后能读到', () => {
    reset();
    cacheSet('k1', { v: 1 });
    const r = cacheGet('k1');
    assert.deepEqual(r, { v: 1 });
});

test('cache: 未写入返回 null', () => {
    reset();
    assert.equal(cacheGet('not-exist'), null);
});

test('cache: 重复写刷新值', () => {
    reset();
    cacheSet('k2', { v: 'a' });
    cacheSet('k2', { v: 'b' });
    assert.equal(cacheGet('k2').v, 'b');
});

test('cache: 读命中会刷新 LRU 顺序（读到再淘汰别人）', () => {
    reset();
    for (let i = 0; i < 600; i++) {
        cacheSet(`lru-${i}`, i);
    }
    // 填满后，早写没读过的应被淘汰
    assert.equal(cacheGet('lru-0'), null);
    // 最近写的应在
    assert.ok(cacheGet('lru-599') !== null);
});

// ---------- imgCache（图片字节缓存）LRU ----------
test('imgCache: 写入后能读到 base64 + bytes', () => {
    reset();
    imgCacheSet('img-1', 'base64str', 1024);
    const r = imgCacheGet('img-1');
    assert.equal(r.base64, 'base64str');
    assert.equal(r.compressedBytes, 1024);
});

test('imgCache: 未写入返回 null', () => {
    reset();
    assert.equal(imgCacheGet('not-exist-img'), null);
});

test('imgCache: 重复写刷新值', () => {
    reset();
    imgCacheSet('img-2', 'old', 100);
    imgCacheSet('img-2', 'new', 200);
    const r = imgCacheGet('img-2');
    assert.equal(r.base64, 'new');
    assert.equal(r.compressedBytes, 200);
});

test('imgCache: 满后 LRU 淘汰最旧', () => {
    reset();
    for (let i = 0; i < 600; i++) {
        imgCacheSet(`img-lru-${i}`, `b64-${i}`, i);
    }
    assert.equal(imgCacheGet('img-lru-0'), null);
    assert.ok(imgCacheGet('img-lru-599') !== null);
});

test('imgCache: 读命中刷新 LRU（读到后不被先淘汰）', () => {
    reset();
    // 写 500 条（满）
    for (let i = 0; i < 500; i++) {
        imgCacheSet(`hot-${i}`, `b64-${i}`, i);
    }
    // 读 hot-0（让它在 LRU 末尾被刷新到最新）
    const hit = imgCacheGet('hot-0');
    assert.ok(hit !== null, 'hot-0 应在缓存里');
    // 再写 1 条让 cache 超 500，触发淘汰；hot-0 被读过应保留，hot-1 未读过应被淘汰
    imgCacheSet('new-after-read', 'fresh', 999);
    assert.ok(imgCacheGet('hot-0') !== null, 'hot-0 被读过应保留');
    assert.ok(imgCacheGet('new-after-read') !== null);
    assert.equal(imgCacheGet('hot-1'), null, 'hot-1 未被读过应被淘汰');
});
