// ============================================================
// mcp-smoke.mjs —— 无头冒烟测试：stdio 启动 MCP，调 analyze_image
// 用法：node test/mcp-smoke.mjs [图片路径] [task]
// 例：  node test/mcp-smoke.mjs "E:\temp\TranscodedWallpaper.jpg" error
// ============================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const imgPath = process.argv[2] || 'E:\\temp\\TranscodedWallpaper.jpg';
const task = process.argv[3] || 'general';

const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['E:\\temp\\mcp-image-analyzer\\index.js']
});
const client = new Client({ name: 'mcp-smoke', version: '0.0.1' });

await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name));

const r = await client.callTool({
    name: 'analyze_image',
    arguments: { path: imgPath, description: '分析这个报错', task, lang: 'zh' }
});
console.log(JSON.stringify(r, null, 2));

await client.close();
