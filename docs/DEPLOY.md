# 公司内网部署

给团队其他成员使用，有两种方式。

## 方案 A（推荐）：集中式远程 MCP

把桥接 + MCP 的 HTTP 入口跑在**一台内网服务器**上，员工只需配一行 URL，**无需装 Node、无需本地桥接**。

### 服务器侧

```bash
cd mcp-image-analyzer
npm install

# 启动（密钥用环境变量注入，只存在服务器上）
MCP_HTTP_PORT=8831 \
MCP_HTTP_HOST=0.0.0.0 \
MCP_AUTH_TOKEN=你的内网token \
node server-http.js
```

生产建议用 pm2 / systemd 守护；同时在同一台机器跑桥接（`node zhipu-bridge-api.js`，MCP 会自动拉起它）。

### 员工侧

员工在自己的 Claude 项目里放一个 `.mcp.json`：

```json
{
  "mcpServers": {
    "image-analyzer": {
      "type": "http",
      "url": "http://内网IP:8831/mcp",
      "headers": {
        "Authorization": "Bearer 内网token",
        "X-User": "工号"
      }
    }
  }
}
```

- `X-User` 会落到桥接的 `?user=`，**限流 / 用量日志按人隔离**。
- **远程模式下：员工本地路径在 bridge 服务器上读不到**，必须用 base64 上传图片（见下方"远程模式图片上传"）。员工的 `analyze_image` 调用体验与本地一致，但 `path`/`paths` 参数在远程模式下不可用。
- 员工机 Node 版本与本方案无关。

### 远程模式图片上传（关键）

集中式远程 MCP 下，bridge 跑在服务器、图片在员工本地，原 `?path=` 方式无法工作。`analyze_image` 工具为此加了 `image_base64` / `images_base64` 参数：

```json
{
  "image_base64": "iVBORw0KGgo...(不带 data:image/png;base64, 前缀)",
  "description": "看下这个报错",
  "task": "error"
}
```

- 单张用 `image_base64`，多张用 `images_base64: [b64, b64, ...]`（最多 6 张）
- bridge 走 `POST /analyze`，body 上限 64MB（足够 6 张压缩前的高清截图）
- 完整字段：`{ images: [{base64}], task?, lang?, desc?, focus?, crop_bbox?, user?, force_action?, raw? }`
- skill 会自动判断：传了 `image_base64` 走 POST，传了 `path` 走 GET（本地模式向后兼容）

## 方案 B：本地分发包

适合内网隔离 / 离线环境。

1. 打包整个项目（含 `mcp-image-analyzer\node_modules`），做成 zip。
2. 员工机装 Node ≥ 18，解压后运行 `node setup.mjs` 填自己的 key（或由公司统一注入 `VISION_API_KEY`）。
3. 员工本地跑 `node zhipu-bridge-api.js`（或依赖 MCP 自动拉起）。
4. **（推荐）装到固定目录**：`node setup.mjs --install`（默认 `~\.claude\claude-eyes`，可 `--dir` 指定）。装完后**解压文件夹可以删除**；更新 = 重新下载 zip 再跑一次 `--install`。

### 升级

- **新用户 / 固定安装**：下载新 zip → 解压 → `node setup.mjs --install`（或 `--update`）。
- **老 v1.00 就地用户**（解压文件夹 + 就地 setup）：下载新 zip → 解压到**新文件夹** → 在里面跑 `node setup.mjs --upgrade`（自动：卸载旧版注册 → 安装全新版本）→ **删旧文件夹**。
- `--upgrade`/`--install` 会打印版本过渡、保留并备份密钥（`vision-config.json.bak`）。

## 分发注意事项（重要）

- **分发前删除 `vision-config.json`**——里面是分发者的密钥，否则同事会继承你的 key。
- 分发包应只含 `vision-config.example.json`（空 key 模板）。
- 换 key：`node setup.mjs --reset-key`。
- 走 git 分发最安全：`vision-config.json` 已被 `.gitignore` 忽略，天然不带密钥。

## 密钥 / 成本 / 隐私

- 每个使用者（或公司统一）应使用独立的视觉模型账号与 key。
- 每次分析是付费 API 调用；远程部署可配合 `RATE_LIMIT_*` 与用量日志管控成本。
- 截图会发送到所配置的视觉模型云端；涉敏数据请评估，或改用本地模型（如 Ollama）作为提供商。
