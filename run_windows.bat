@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python 启动器（py）。
    echo 请确认 Komandare 的 Python 3.8 环境已正确安装并已加入 PATH。
    pause
    exit /b 1
)

py -c "import sys; print('Using Python ' + sys.version); raise SystemExit(0 if sys.version_info[:2] == (3, 8) else 1)"
if errorlevel 1 (
    echo [错误] 当前 py 不是 Python 3.8。请在 Komandare 的 Python 3.8 环境中运行此脚本。
    pause
    exit /b 1
)

py -m pip install -r requirements.txt
if errorlevel 1 goto :failed
py app.py
exit /b %errorlevel%

:failed
echo.
echo [错误] 依赖安装失败。请检查网络连接和 Python 3.8 的 pip 配置。
pause
exit /b 1
