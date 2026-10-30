@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist "%LOCALAPPDATA%\IDMS\runtime\pgsql\bin\pg_ctl.exe" if exist "%LOCALAPPDATA%\IDMS\runtime\postgres-data\PG_VERSION" goto runtime_ready
set "IDMS_LOCAL_RUNTIME_BASE=%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local"
if not exist "%IDMS_LOCAL_RUNTIME_BASE%\IDMS\runtime\pgsql\bin\pg_ctl.exe" goto runtime_missing
if not exist "%IDMS_LOCAL_RUNTIME_BASE%\IDMS\runtime\postgres-data\PG_VERSION" goto runtime_missing
set "LOCALAPPDATA=%IDMS_LOCAL_RUNTIME_BASE%"
:runtime_ready
"C:\Program Files\nodejs\node.exe" --input-type=module -e "try{const a=await fetch('http://127.0.0.1:4010/',{method:'HEAD',signal:AbortSignal.timeout(2000)});const b=await fetch('http://127.0.0.1:8081/realms/idms/.well-known/openid-configuration',{signal:AbortSignal.timeout(2000)});const c=await b.json();process.exit(a.ok&&b.ok&&c.issuer==='http://127.0.0.1:8081/realms/idms'?0:1);}catch{process.exit(1);}"
if errorlevel 1 goto start_services
echo IDMS is already running: http://127.0.0.1:4010/?view=predictive
pause
exit /b 0
:start_services
"C:\Program Files\nodejs\node.exe" scripts/start-platform-v4.mjs
pause
exit /b
:runtime_missing
echo Existing IDMS database runtime was not found. No new database was initialized.
pause
exit /b 1
