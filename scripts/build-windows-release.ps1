[CmdletBinding()]
param(
    [switch]$WithFFmpeg,
    [string]$Version = "dev"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = Join-Path $ProjectRoot ".release-build"
$DistRoot = Join-Path $ProjectRoot "release"
$FfmpegRoot = Join-Path $BuildRoot "ffmpeg"
$FfmpegArchive = Join-Path $BuildRoot "ffmpeg-master-latest-win64-gpl.zip"
$FfmpegArchiveName = "ffmpeg-master-latest-win64-gpl.zip"
$FfmpegBaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download"

Set-Location $ProjectRoot
Remove-Item -Recurse -Force $BuildRoot, $DistRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $BuildRoot, $DistRoot | Out-Null

python -m pip install --upgrade "pip<25"
python -m pip install -r requirements.txt "pyinstaller==6.6.0"

$env:PYTHONPATH = "$(Join-Path $ProjectRoot 'vendor')$([IO.Path]::PathSeparator)$env:PYTHONPATH"
$variant = if ($WithFFmpeg) { "with-ffmpeg" } else { "standard" }
$fileStem = if ($WithFFmpeg) {
    "BaiduPhotoSync-$Version-Windows-x64-with-ffmpeg"
} else {
    "BaiduPhotoSync-$Version-Windows-x64"
}

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

if ($WithFFmpeg) {
    Write-Host "Downloading and verifying bundled FFmpeg tools..."
    Invoke-WebRequest "$FfmpegBaseUrl/$FfmpegArchiveName" -OutFile $FfmpegArchive
    $checksums = (Invoke-WebRequest "$FfmpegBaseUrl/checksums.sha256").Content
    $pattern = "(?m)^([a-fA-F0-9]{64})\s+\*?$([regex]::Escape($FfmpegArchiveName))$"
    $match = [regex]::Match($checksums, $pattern)
    if (-not $match.Success) {
        throw "The expected FFmpeg checksum was not present in checksums.sha256."
    }
    $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
    $actualHash = (Get-FileHash $FfmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "FFmpeg checksum verification failed."
    }
    Expand-Archive -Path $FfmpegArchive -DestinationPath $FfmpegRoot -Force
    $ffmpeg = Get-ChildItem -Path $FfmpegRoot -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    $ffprobe = Get-ChildItem -Path $FfmpegRoot -Filter "ffprobe.exe" -Recurse | Select-Object -First 1
    if ($null -eq $ffmpeg -or $null -eq $ffprobe) {
        throw "The verified FFmpeg archive did not contain both required executables."
    }
    $arguments += "--add-binary", "$($ffmpeg.FullName);ffmpeg"
    $arguments += "--add-binary", "$($ffprobe.FullName);ffmpeg"
}

& python -m PyInstaller @arguments app.py
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed for the $variant variant."
}

$builtExecutable = Join-Path $ProjectRoot "dist\$fileStem\$fileStem.exe"
if (-not (Test-Path $builtExecutable)) {
    $builtExecutable = Join-Path $ProjectRoot "dist\$fileStem.exe"
}
if (-not (Test-Path $builtExecutable)) {
    throw "PyInstaller did not produce the expected executable."
}

$releaseExecutable = Join-Path $DistRoot "$fileStem.exe"
Copy-Item $builtExecutable $releaseExecutable
Get-FileHash $releaseExecutable -Algorithm SHA256 | Format-List
Write-Host "Release artifact: $releaseExecutable"
