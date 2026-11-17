@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto :bad_directory

python -c "import fastapi,uvicorn,httpx,PIL,sqlite3" >nul 2>&1
if not errorlevel 1 goto :run_python

py -3 -c "import fastapi,uvicorn,httpx,PIL,sqlite3" >nul 2>&1
if not errorlevel 1 goto :run_launcher

echo Python dependencies are missing. Run: python -m pip install -r requirements.txt
goto :failure

:run_python
python "%~dp0launch.py" %*
goto :finished

:run_launcher
py -3 "%~dp0launch.py" %*
goto :finished

:finished
if errorlevel 1 goto :failure
popd
exit /b 0

:failure
popd

:bad_directory
pause
exit /b 1
