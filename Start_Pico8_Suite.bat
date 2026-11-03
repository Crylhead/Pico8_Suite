@echo off
setlocal
rem The helper resolves the Suite folder from its own path, independent of this working directory.
py -3 --version >nul 2>&1
if not errorlevel 1 (
  py -3 "%~dp0tools\serve_suite.py" %*
  goto done
)
python --version >nul 2>&1
if not errorlevel 1 (
  python "%~dp0tools\serve_suite.py" %*
  goto done
)
echo Python 3.9 or newer is needed for this optional local launcher.
echo Install Python, then run Start_Pico8_Suite.bat again.
pause
exit /b 1
:done
set "suite_exit=%errorlevel%"
if not "%suite_exit%"=="0" pause
exit /b %suite_exit%
