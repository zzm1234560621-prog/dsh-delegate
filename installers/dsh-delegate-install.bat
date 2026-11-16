@echo off
rem One-file installer for dsh-delegate on Windows: double-click it.
rem
rem Downloads the latest release package, unpacks it into a temporary folder and runs
rem its install.cmd. The install copies what it needs into %USERPROFILE%\.dsh\bridge,
rem so the temporary folder is deleted afterwards. Flags pass through:
rem   dsh-delegate-install.bat --dry-run
rem   dsh-delegate-install.bat --autostart
rem
rem   set DSH_DELEGATE_ZIP=C:\path\dsh-delegate.zip   install from a package you already have
rem   set DSH_DELEGATE_ZIP_URL=https://...             download from another address
rem   set DSH_DELEGATE_NO_PAUSE=1                      do not wait for a key at the end
rem
rem Plain ASCII on purpose: cmd reads this file in the console code page.
setlocal EnableExtensions DisableDelayedExpansion

set "URL=https://github.com/zzm1234560621-prog/dsh-delegate/releases/latest/download/dsh-delegate.zip"
if defined DSH_DELEGATE_ZIP_URL set "URL=%DSH_DELEGATE_ZIP_URL%"
set "WORK=%TEMP%\dsh-delegate-setup-%RANDOM%%RANDOM%"
set "ZIP=%WORK%\dsh-delegate.zip"
set "HOLD=1"
if defined DSH_DELEGATE_NO_PAUSE set "HOLD="
rem install.ps1 would wait for Enter as well; one prompt is enough.
set "DSH_DELEGATE_NO_PAUSE=1"
mkdir "%WORK%" 2>nul || goto :fail

if defined DSH_DELEGATE_ZIP goto :local
echo Downloading the latest dsh-delegate:
echo   "%URL%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:ZIP } catch { Write-Host $_.Exception.Message; exit 1 }" || goto :nodownload
goto :unpack

:local
echo Using "%DSH_DELEGATE_ZIP%"
copy /y "%DSH_DELEGATE_ZIP%" "%ZIP%" >nul || goto :fail

:unpack
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Expand-Archive -Force -LiteralPath $env:ZIP -DestinationPath $env:WORK } catch { Write-Host $_.Exception.Message; exit 1 }" || goto :fail
set "PKG="
for /d %%D in ("%WORK%\dsh-delegate-v*") do set "PKG=%%D"
if not defined PKG goto :nopackage

call "%PKG%\install.cmd" %*
set "CODE=%errorlevel%"
rmdir /s /q "%WORK%" 2>nul
if defined HOLD pause
exit /b %CODE%

:nopackage
echo The package has no dsh-delegate-v* folder.
goto :fail

:nodownload
echo.
echo Could not download the package.
echo If GitHub is unreachable from this network, turn on your proxy and run this again,
echo or get dsh-delegate.zip from the Releases page another way, then run in cmd:
echo   set DSH_DELEGATE_ZIP=C:\path\to\dsh-delegate.zip
echo   "%~f0"
goto :failed

:fail
echo.
echo The installation did not finish.

:failed
rmdir /s /q "%WORK%" 2>nul
if defined HOLD pause
exit /b 1
