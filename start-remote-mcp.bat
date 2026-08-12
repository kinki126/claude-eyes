@echo off
rem start-remote-mcp.bat - start remote MCP HTTP entry (company deployment, port 8831)
rem Optional env: MCP_HTTP_PORT / MCP_HTTP_HOST / MCP_AUTH_TOKEN
cd /d "%~dp0mcp-image-analyzer"
set MCP_HTTP_PORT=8831
set MCP_AUTH_TOKEN=CHANGE_ME
node server-http.js
