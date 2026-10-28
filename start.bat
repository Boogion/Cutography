@echo off
rem Cutography: starts the app from source and opens it in your browser.
rem Needs Python 3.9 or newer (https://www.python.org/downloads/). Close this window to quit.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && (py -3 -m cutography %* & goto :end))
where python >nul 2>nul && (python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && (python -m cutography %* & goto :end))
echo.
echo   Python 3.9 or newer was not found.
echo   Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),
echo   or download the ready-made Cutography.exe from the project's Releases page.
echo.
pause
:end
