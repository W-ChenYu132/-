@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 云作业 · 在线作业平台

if not defined PORT set PORT=3000

if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖，请稍候...
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请确认已安装 Node.js ^(nodejs.org^) 并联网。
    pause
    exit /b 1
  )
)

echo [2/2] 正在启动服务...
start "" http://localhost:%PORT%
node src/server.js
pause
