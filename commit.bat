@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo === %cd% ===
git status --short
echo.

git add -A

set FLAGGED=0
for /f "delims=" %%f in ('git diff --cached --name-only') do (
    echo %%f | findstr /i /r "\.env$ \.pem$ \.key$ secret credential password" >nul
    if not errorlevel 1 (
        echo   [!] Staged file looks sensitive: %%f
        set FLAGGED=1
    )
)

if "!FLAGGED!"=="1" (
    echo.
    set /p CONFIRM="Sensitive-looking file(s) staged above - commit anyway? (y/N): "
    if /i not "!CONFIRM!"=="y" (
        git reset >nul
        echo Aborted, unstaged everything.
        pause
        exit /b 1
    )
)

echo.
set /p MSG="Commit message: "
if "%MSG%"=="" (
    echo No message entered, aborting.
    git reset >nul
    pause
    exit /b 1
)

git commit -m "%MSG%"
echo.
git log --oneline -1

echo.
git rev-parse --abbrev-ref --symbolic-full-name @{u} >nul 2>&1
if errorlevel 1 (
    echo No upstream remote configured for this branch - skipping push.
) else (
    echo Pushing to remote...
    git push
)

pause
