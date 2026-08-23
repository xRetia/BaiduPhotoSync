@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===============================================
echo   一刻同步 - Windows EXE 打包
echo ===============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python 启动器（py）。
    echo 请确认 Python 3.8 已正确安装，且 python 启动器可用。
    pause
    exit /b 1
)

python -c "import sys; print('Using Python ' + sys.version); raise SystemExit(0 if sys.version_info[:2] == (3, 8) else 1)"
if errorlevel 1 (
    echo [错误] 当前 python 不是 Python 3.8。请在 Komandare 的 Python 3.8 环境中运行此脚本。
    pause
    exit /b 1
)

if not exist "assets\yike_sync.ico" (
    echo [错误] 找不到 assets\yike_sync.ico，无法嵌入程序图标。
    pause
    exit /b 1
)

echo [1/3] 安装或更新打包依赖...
python -m pip install --upgrade "pip<25"
if errorlevel 1 goto :failed
python -m pip install -r requirements.txt "pyinstaller==6.6.0"
if errorlevel 1 goto :failed

echo [2/3] 清理旧构建目录...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist "一刻同步.spec" del /q "一刻同步.spec"

echo [3/3] 正在生成 EXE（首次通常需要数分钟）...
python -m PyInstaller --noconfirm --clean --windowed --onedir --name "一刻同步" --icon "assets\yike_sync.ico" --paths "vendor" --collect-submodules pybaiduphoto --hidden-import file_client_worker --add-data "assets;assets" --add-data "vendor;vendor" app.py
if errorlevel 1 goto :failed

echo.
echo 打包完成。
echo 主程序：%cd%\dist\一刻同步\一刻同步.exe
echo 注意：请保留 dist\一刻同步 文件夹内的全部文件，再运行一刻同步.exe。
echo 当前版本保留控制台窗口，方便查看 DEBUG 日志；如不需要日志，可将脚本中的 --console 改为 --windowed 后重新打包。
echo.
start "" explorer "%cd%\dist\一刻同步"
pause
exit /b 0

:failed
echo.
echo [错误] 打包失败。请复制上方完整输出，并检查 Python、网络和磁盘空间是否正常。
pause
exit /b 1
