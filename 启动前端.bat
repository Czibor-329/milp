@echo off
setlocal

rem 本脚本从仓库根目录启动调度平台，并由 Python 服务托管当前前端资源。
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHON_EXE="
set "PYTHON_ARGS="

if exist "%~dp0venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0venv\Scripts\python.exe"
) else if exist "%~dp0alg\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0alg\.venv\Scripts\python.exe"
) else (
    where py >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_EXE=py"
        set "PYTHON_ARGS=-3"
    ) else (
        where python >nul 2>&1
        if not errorlevel 1 set "PYTHON_EXE=python"
    )
)

if not defined PYTHON_EXE (
    echo [错误] 未找到 Python 3。请先安装 Python，或在项目根目录创建 venv 虚拟环境。
    pause
    exit /b 1
)

echo 正在启动调度平台：http://127.0.0.1:8765
echo 关闭此窗口即可停止服务。
echo.

"%PYTHON_EXE%" %PYTHON_ARGS% "%~dp0realtime_scheduler\server.py" --port 8765 --open
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" echo [错误] 服务启动失败，退出代码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
