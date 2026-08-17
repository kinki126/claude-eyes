#!/usr/bin/env node
// ============================================================
// index.js —— MCP stdio 入口（本地 Claude Code 用）
// 启动：node E:\temp\mcp-image-analyzer\index.js
// ============================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAnalyzeImageHandler, createLocateCodeHandler, createSearchHistoryHandler } from './analyze-tool.js';

const server = new McpServer({ name: 'mcp-image-analyzer', version: '1.6.1' });

server.tool(
    'analyze_image',
    '分析本地图片/截图（报错、界面、文字）。传入本地绝对路径。必须读取返回中的 control.action：' +
    'continue=继续等待下一张图片；stop=总结并结束本次分析流程，不得再请求更多图片。',
    {
        path: z.string().optional().describe('本地图片绝对路径（单张），Windows 格式，如 E:\\temp\\shot.png；与 paths 或 image_base64 三选一'),
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
    },
    createAnalyzeImageHandler()
);

server.tool(
    'locate_code',
    '在项目代码里搜索关键词（优先用 analyze_image 返回的 keywords），返回 文件:行号:匹配行 候选列表。' +
    '比直接 grep 更结构化，Claude 拿到候选后可用 Read 工具读上下文判断是否是问题代码。',
    {
        keywords: z.array(z.string()).min(1).max(10).describe('要搜索的关键词数组（1~10 个），如 ["TypeError","renderX"]。优先用 analyze_image 返回的 keywords'),
        project_root: z.string().optional().describe('项目根目录（绝对路径），不传则用默认项目根'),
        max_hits_per_keyword: z.number().optional().describe('每个关键词最多返回多少条命中（默认 5，上限 20）'),
        file_extensions: z.array(z.string()).optional().describe('要搜索的文件扩展名数组，如 [".js",".ts"]；不传则默认常见代码文件')
    },
    createLocateCodeHandler()
);

server.tool(
    'search_history',
    '搜索历史分析记录（按 task / keyword / 时间范围过滤），返回最近的分析记录列表。' +
    '用户说"找昨天的报错分析""上周那张 TypeError 的图"时用。',
    {
        task: z.enum(['general', 'error', 'diff', 'ocr', 'ui', 'verify']).optional().describe('按任务类型过滤'),
        keyword: z.string().optional().describe('关键词（在 analysis 文本和 keywords 数组里模糊匹配，大小写不敏感）'),
        since: z.string().optional().describe('起始时间（ISO 字符串或 yyyy-mm-dd）'),
        until: z.string().optional().describe('结束时间（ISO 字符串或 yyyy-mm-dd）'),
        limit: z.number().optional().describe('返回条数上限（默认 20，上限 100）'),
        user: z.string().optional().describe('按用户过滤（管理员场景）')
    },
    createSearchHistoryHandler()
);

const transport = new StdioServerTransport();
await server.connect(transport);
