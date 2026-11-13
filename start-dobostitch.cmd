@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\proxy\cli.js" (
  echo [DoboCache] dist\proxy\cli.js not found.
  echo Please make sure this file sits in the ROOT of the extracted folder and the unzip is complete.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  DoboCache local proxy  ^(dobostitch^)
echo  Start : just double-click this file
echo  Stop  : press Ctrl+C in this window, or close the window
echo  Port  : default 27880; if taken it shifts up by 1  ^(27881, ...^)
echo          ALWAYS use the address printed below.
echo ============================================================
echo.

node "dist\proxy\cli.js" start %*

echo.
echo [DoboCache] proxy exited.
pause
