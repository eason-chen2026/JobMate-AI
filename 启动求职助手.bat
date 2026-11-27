@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动本地隐私求职助手（仅限本机 127.0.0.1 访问）...
start "" http://127.0.0.1:3456
node src/server.mjs
pause
