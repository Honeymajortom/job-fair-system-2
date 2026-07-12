@echo off
setlocal

REM Starts Redis (Docker), the API + no-show worker, and the React dev server
REM for the SDC Job Fair prototype. Postgres is assumed to already be running
REM as a Windows service.
REM
REM Phase 6 cutover (2026-07-12): the old "dispatch worker" (npm run worker ->
REM workers/slotDispatcher.js, BullMQ delayed jobs at slot_start-2min) is gone
REM along with v1's fixed-slot-time dispatch. The new count-based queue model
REM dispatches synchronously inside request handlers (lib/queueDispatcher.js)
REM - no worker process needed for that. The no-show timer (Phase 3) still
REM needs its own worker, so that's what this window runs now instead.

set ROOT=%~dp0
set API_DIR=%ROOT%express-app
set WEB_DIR=%ROOT%react-app
set DOCKER_EXE="C:\Program Files\Docker\Docker\Docker Desktop.exe"

echo Checking Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
    echo Docker Desktop not running, starting it...
    start "" %DOCKER_EXE%
    echo Waiting for Docker to be ready, this can take a minute...
    :waitdocker
    timeout /t 2 >nul
    docker info >nul 2>&1
    if errorlevel 1 goto waitdocker
)
echo Docker is ready.

echo Starting Redis container...
docker start jobfair-redis >nul 2>&1
if errorlevel 1 (
    echo Container not found, creating jobfair-redis...
    docker run -d --name jobfair-redis -p 6379:6379 -v jobfair-redis-data:/data --restart unless-stopped redis:7-alpine redis-server --appendonly yes >nul
)

echo Waiting for Redis to accept connections...
:waitredis
docker exec jobfair-redis redis-cli ping >nul 2>&1
if errorlevel 1 (
    timeout /t 1 >nul
    goto waitredis
)
echo Redis is up.

echo Starting API server...
start "jobfair-api" cmd /k "cd /d "%API_DIR%" && npm run dev"

echo Starting no-show worker...
start "jobfair-worker" cmd /k "cd /d "%API_DIR%" && npm run worker:noshow"

echo Starting React dev server...
start "jobfair-web" cmd /k "cd /d "%WEB_DIR%" && npm run dev"

echo.
echo All services launching in separate windows:
echo   - jobfair-api    (http://localhost:3000)
echo   - jobfair-worker (BullMQ no-show timer)
echo   - jobfair-web    (Vite dev server, usually http://localhost:5173)
echo Close those windows individually to stop each service.
