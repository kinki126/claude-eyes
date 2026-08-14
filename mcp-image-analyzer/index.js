#!/usr/bin/env node
// ============================================================
// index.js —— MCP stdio 入口（本地 Claude Code 用）
// 启动：node E:\temp\mcp-image-analyzer\index.js
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAnalyzeImageHandler } from './analyze-tool.js';

const server = new McpServer({ name: 'mcp-image-analyzer', version: '1.0.0' });

server.tool(
    'analyze_image',
    '分析本地图片/截图（报错、界面、文字）。传入本地绝对路径。必须读取返回中的 control.action：' +
    'continue=继续等待下一张图片；stop=总结并结束本次分析流程，不得再请求更多图片。',
    {
        path: z.string().optional().describe('本地图片绝对路径（单张），Windows 格式，如 E:\\temp\\shot.png；与 paths 二选一'),
        paths: z.array(z.string()).max(6).optional().describe('多张图片绝对路径（最多 6 张，模型会一起分析；与 path 二选一）'),
        description: z.string().optional().describe('用户的文字描述，透传给视觉模型，可省略'),
        task: z.enum(['error', 'ui', 'ocr', 'general', 'diff']).optional().default('general')
            .describe('分析任务类型：error=报错定位 ui=界面走查 ocr=纯文字提取 diff=多图差异对比 general=全面分析'),
        lang: z.enum(['zh', 'en']).optional().default('zh').describe('analysis 输出语言：zh=中文 en=English'),
        mode: z.enum(['auto']).optional().default('auto').describe('当前仅支持 auto（模型自动决定继续/停止）')
    },
    createAnalyzeImageHandler()
);

const transport = new StdioServerTransport();
await server.connect(transport);
