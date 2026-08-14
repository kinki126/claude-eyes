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

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createAnalyzeImageHandler, userContext } from './analyze-tool.js';

const PORT = Number(process.env.MCP_HTTP_PORT || 8831);
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

const TOOL_DESCRIPTION =
    '分析图片/截图（报错、界面、文字）。传入绝对路径。必须读取返回中的 control.action：' +
    'continue=继续等待下一张图片；stop=总结并结束本次分析流程，不得再请求更多图片。';
const TOOL_SCHEMA = {
    path: z.string().optional().describe('图片绝对路径（单张），Windows 格式，如 E:\\temp\\shot.png；与 paths 二选一'),
    paths: z.array(z.string()).max(6).optional().describe('多张图片绝对路径（最多 6 张，模型会一起分析；与 path 二选一）'),
    description: z.string().optional().describe('用户的文字描述，透传给视觉模型，可省略'),
    focus: z.string().optional().describe('重点关注区域/问题（自然语言，如"左上角红框里的报错文字""第3个按钮的文案"）。多轮追问时让视觉模型定向细看该区域，可省略'),
    task: z.enum(['error', 'ui', 'ocr', 'general', 'diff', 'verify']).optional().default('general')
        .describe('分析任务类型：error=报错定位 ui=界面走查 ocr=纯文字提取 diff=多图差异对比 verify=核验断言 general=全面分析'),
    lang: z.enum(['zh', 'en']).optional().default('zh').describe('analysis 输出语言：zh=中文 en=English'),
    mode: z.enum(['auto']).optional().default('auto').describe('当前仅支持 auto（模型自动决定继续/停止）')
};

/** 每个会话一个独立的 McpServer（Protocol 单 transport 限制） */
function createMcpServer() {
    const srv = new McpServer({ name: 'mcp-image-analyzer', version: '1.0.0' });
    srv.tool('analyze_image', TOOL_DESCRIPTION, TOOL_SCHEMA, createAnalyzeImageHandler({ user: 'remote' }));
    return srv;
}

function randomId() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function authorized(req) {
    if (!AUTH_TOKEN) return true;
    return (req.headers['authorization'] || '') === `Bearer ${AUTH_TOKEN}`;
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
