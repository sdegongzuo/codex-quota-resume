@echo off
setlocal
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" (
  "%CODEX_MCP_NODE_PATH%" %*
  exit /b
)
where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js，请在 Codex 桌面聊天中运行或安装 Node.js 22 及以上版本。 1>&2
  exit /b 127
)
node %*
exit /b
