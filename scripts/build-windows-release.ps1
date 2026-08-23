[CmdletBinding()]
param(
    [string]$Version = "dev"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DistRoot = Join-Path $ProjectRoot "release"

Set-Location $ProjectRoot
Remove-Item -Recurse -Force $DistRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $DistRoot | Out-Null

python -m pip install --upgrade "pip<25"
python -m pip install -r requirements.txt "pyinstaller==6.6.0"

$env:PYTHONPATH = "$(Join-Path $ProjectRoot 'vendor')$([IO.Path]::PathSeparator)$env:PYTHONPATH"
$fileStem = "BaiduPhotoSync-$Version-Windows-x64"

$arguments = @(
    "--noconfirm",
    "--clean",
    "--onefile",
    "--windowed",
    "--name", $fileStem,
    "--icon", "assets\yike_sync.ico",
    "--paths", "vendor",
    "--collect-submodules", "pybaiduphoto",
    "--collect-all", "PySide6.QtWebEngineCore",
    "--collect-all", "PySide6.QtWebEngineWidgets",
    "--hidden-import", "file_client_worker",
    "--hidden-import", "video_compression",
    "--hidden-import", "ffmpeg_downloader",
    "--hidden-import", "session_store",
    "--hidden-import", "web_login",
    "--add-data", "assets;assets",
    "--add-data", "vendor;vendor"
)

& python -m PyInstaller @arguments app.py
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed for the Windows x64 release build."
}

$builtExecutable = Join-Path $ProjectRoot "dist\$fileStem.exe"
if (-not (Test-Path $builtExecutable)) {
    throw "PyInstaller did not produce the expected executable."
}

$releaseExecutable = Join-Path $DistRoot "$fileStem.exe"
Copy-Item $builtExecutable $releaseExecutable
Get-FileHash $releaseExecutable -Algorithm SHA256 | Format-List
Write-Host "Release artifact: $releaseExecutable"
