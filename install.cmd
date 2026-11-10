@echo off
rem One-click installer for dsh-delegate (Windows).
rem Picks PowerShell 7 when available, otherwise Windows PowerShell 5.1.
setlocal
set "HERE=%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
)
exit /b %errorlevel%
