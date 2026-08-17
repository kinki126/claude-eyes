#!/usr/bin/env node
// ============================================================
// server-http.js —— MCP 远程 HTTP 入口（公司集中部署用，方案 A）
// 启动：node server-http.js
//   可选 env：MCP_HTTP_PORT(默认8831) / MCP_HTTP_HOST(默认127.0.0.1) / MCP_AUTH_TOKEN
// 员工 .mcp.json 配置示例：
//   { "type": "http", "url": "http://内网IP:8831/mcp",
//     "headers": { "Authorization": "Bearer <token>", "X-User": "<工号>" } }
// X-User 经 userContext 注入桥接的 ?user=，用于限流/用量日志按人隔离。
// 说明：SDK 的 Protocol.connect 一个实例只能连一个 transport，
// 因此每个会话(employee)使用独立的 McpServer 实例。
// ============================================================

import crypto from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createAnalyzeImageHandler, createLocateCodeHandler, createSearchHistoryHandler, userContext } from './analyze-tool.js';

const PORT = Number(process.env.MCP_HTTP_PORT || 8831);
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

const TOOL_DESCRIPTION =
    '分析图片/截图（报错、界面、文字）。传入绝对路径。必须读取返回中的 control.action：' +
    'continue=继续等待下一张图片；stop=总结并结束本次分析流程，不得再请求更多图片。';
const TOOL_SCHEMA = {
    path: z.string().optional().describe('图片绝对路径（单张），Windows 格式，如 E:\\temp\\shot.png；与 paths 或 image_base64 三选一'),
    paths: z.array(z.string()).max(6).optional().describe('多张图片绝对路径（最多 6 张，模型会一起分析；与 path 或 images_base64 三选一）'),
    image_base64: z.string().optional().describe('单张图片的 base64 内容（不带 data:image/png;base64, 前缀）。远程模式/无本地路径时用；与 images_base64 二选一'),
    images_base64: z.array(z.string()).max(6).optional().describe('多张图片的 base64 内容（最多 6 张）。远程模式下批量上传；与 image_base64 二选一'),
    description: z.string().optional().describe('用户的文字描述，透传给视觉模型，可省略'),
    focus: z.string().optional().describe('重点关注区域/问题（自然语言，如"左上角红框里的报错文字""第3个按钮的文案"）。多轮追问时让视觉模型定向细看该区域，可省略'),
    crop_bbox: z.object({
        x: z.number(), y: z.number(), w: z.number(), h: z.number()
    }).optional().describe('按归一化 bbox 裁剪第 0 张图并放大后再分析，用于多轮追问细看某区域。取值来自上一轮返回的 regions[].bbox（x/y/w/h 均为 0.0~1.0）'),
    task: z.enum(['error', 'ui', 'ocr', 'general', 'diff', 'verify']).optional().default('general')
        .describe('分析任务类型：error=报错定位 ui=界面走查 ocr=纯文字提取 diff=多图差异对比 verify=核验断言 general=全面分析'),
    lang: z.enum(['zh', 'en']).optional().default('zh').describe('analysis 输出语言：zh=中文 en=English'),
    mode: z.enum(['auto']).optional().default('auto').describe('当前仅支持 auto（模型自动决定继续/停止）')
};

const LOCATE_CODE_DESCRIPTION =
    '在项目代码里搜索关键词（优先用 analyze_image 返回的 keywords），返回 文件:行号:匹配行 候选列表。' +
    '比直接 grep 更结构化，Claude 拿到候选后可用 Read 工具读上下文判断是否是问题代码。' +
    '注意：远程模式下搜索的是服务器上的代码目录，请确保 project_root 指向服务器上的有效路径。';
const LOCATE_CODE_SCHEMA = {
    keywords: z.array(z.string()).min(1).max(10).describe('要搜索的关键词数组（1~10 个），如 ["TypeError","renderX"]。优先用 analyze_image 返回的 keywords'),
    project_root: z.string().optional().describe('项目根目录（绝对路径），不传则用默认项目根'),
    max_hits_per_keyword: z.number().optional().describe('每个关键词最多返回多少条命中（默认 5，上限 20）'),
    file_extensions: z.array(z.string()).optional().describe('要搜索的文件扩展名数组，如 [".js",".ts"]；不传则默认常见代码文件')
};

const SEARCH_HISTORY_DESCRIPTION =
    '搜索历史分析记录（按 task / keyword / 时间范围过滤），返回最近的分析记录列表。' +
    '用户说"找昨天的报错分析""上周那张 TypeError 的图"时用。';
const SEARCH_HISTORY_SCHEMA = {
    task: z.enum(['general', 'error', 'diff', 'ocr', 'ui', 'verify']).optional().describe('按任务类型过滤'),
    keyword: z.string().optional().describe('关键词（在 analysis 文本和 keywords 数组里模糊匹配，大小写不敏感）'),
    since: z.string().optional().describe('起始时间（ISO 字符串或 yyyy-mm-dd）'),
    until: z.string().optional().describe('结束时间（ISO 字符串或 yyyy-mm-dd）'),
    limit: z.number().optional().describe('返回条数上限（默认 20，上限 100）'),
    user: z.string().optional().describe('按用户过滤（管理员场景）')
};

/** 每个会话一个独立的 McpServer（Protocol 单 transport 限制） */
function createMcpServer() {
    const srv = new McpServer({ name: 'mcp-image-analyzer', version: '1.6.2' });
    srv.tool('analyze_image', TOOL_DESCRIPTION, TOOL_SCHEMA, createAnalyzeImageHandler({ user: 'remote' }));
    srv.tool('locate_code', LOCATE_CODE_DESCRIPTION, LOCATE_CODE_SCHEMA, createLocateCodeHandler());
    srv.tool('search_history', SEARCH_HISTORY_DESCRIPTION, SEARCH_HISTORY_SCHEMA, createSearchHistoryHandler());
    return srv;
}

function randomId() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function authorized(req) {
    if (!AUTH_TOKEN) return true;
    const got = String(req.headers['authorization'] || '');
    const want = `Bearer ${AUTH_TOKEN}`;
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const app = express();
app.use(express.json({ type: ['application/json', 'text/plain'] }));

/** sessionId -> { transport, server, lastActive } */
const sessions = new Map();
const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 15 * 60 * 1000);

/** 定期清理闲置会话：避免 SSE 响应结束后会话泄漏 */
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.lastActive > SESSION_TTL_MS) {
            s.transport.close();
            s.server.close();
            sessions.delete(id);
        }
    }
}, 60000).unref();

app.use('/mcp', (req, res, next) => {
    if (!authorized(req)) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }
    next();
});

app.get('/health', (req, res) => {
    res.json({ ok: true, status: 'up', sessions: sessions.size });
});

app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let session;
    if (sessionId) {
        session = sessions.get(sessionId);
        if (!session) {
            res.status(400).json({ ok: false, error: 'invalid session' });
            return;
        }
    } else {
        const srv = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomId,
            // 会话在 handleRequest 过程中建立（sessionId 生成），在此登记。
            // 注意：不要在 res close 时删除会话——单次 POST 的 SSE 响应结束不等于会话结束。
            onsessioninitialized: (id) => {
                sessions.set(id, { transport, server: srv, lastActive: Date.now() });
            }
        });
        await srv.connect(transport); // 关键：transport 必须连上 McpServer
        session = { transport, server: srv, lastActive: Date.now() };
    }
    session.lastActive = Date.now();
    await userContext.run({ user: req.headers['x-user'] || 'remote' }, () =>
        session.transport.handleRequest(req, res, req.body));
});

app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
        res.status(400).json({ ok: false, error: 'invalid session' });
        return;
    }
    session.lastActive = Date.now();
    await userContext.run({ user: req.headers['x-user'] || 'remote' }, () =>
        session.transport.handleRequest(req, res));
});

app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
        sessions.delete(sessionId);
        await session.transport.close();
        await session.server.close();
    }
    res.status(204).end();
});

app.listen(PORT, HOST, () => {
    console.log(`MCP 远程入口已启动: http://${HOST}:${PORT}/mcp${AUTH_TOKEN ? '（已启用 token 鉴权）' : ''}`);
});
