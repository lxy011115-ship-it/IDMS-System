@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)"
if errorlevel 1 goto node_missing
node scripts/inspect-platform.mjs %*
set "IDMS_INSPECT_EXIT=%ERRORLEVEL%"
echo.
echo 默认报告位于 .local\inspection-reports 下新建的目录。
echo 此入口只检查，不启动、重启或修改业务服务。
pause
exit /b %IDMS_INSPECT_EXIT%
:node_missing
echo 需要现有的 Node.js 24 运行环境。此入口不会自动安装软件。
pause
exit /b 3
