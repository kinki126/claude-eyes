// ============================================================
// server-http-smoke.mjs —— 远程 MCP HTTP 冒烟测试
// 用法：node test/server-http-smoke.mjs [url] [x-user]
// 例：  node test/server-http-smoke.mjs http://127.0.0.1:8831/mcp zhangsan
// ============================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.argv[2] || 'http://127.0.0.1:8831/mcp';
const xUser = process.argv[3] || 'test-employee';
const token = process.argv[4] || '';

const headers = { 'X-User': xUser };
if (token) headers['Authorization'] = `Bearer ${token}`;
const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers }
});
const client = new Client({ name: 'http-smoke', version: '0.0.1' });

await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name));

const r = await client.callTool({
    name: 'analyze_image',
    arguments: { path: 'E:\\temp\\TranscodedWallpaper.jpg', description: '远程冒烟', task: 'general', lang: 'zh' }
});
console.log(JSON.stringify(r, null, 2));

await client.close();
console.log('closed.');
