# ---------------------------------------------------------------------------
# Vendors `uv.exe` into vendor/uv/ so `pnpm tauri build` can bundle it as a
# resource (the guided Hunyuan installer spawns it to provision Python + venvs).
#
# vendor/ is git-ignored (uv.exe is a ~65 MB binary), so each build machine runs
# this once. Re-run to update uv.
#
#     pwsh scripts/fetch-uv.ps1            # latest
#     pwsh scripts/fetch-uv.ps1 -Version 0.5.11
# ---------------------------------------------------------------------------
param(
    [string]$Version = "latest",
    [switch]$Force
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "vendor\uv"
$exe = Join-Path $dest "uv.exe"
if ((Test-Path $exe) -and (-not $Force)) {
    Write-Host "[fetch-uv] vendor\uv\uv.exe already present (use -Force to refresh)"
    return
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

if ($Version -eq "latest") {
    $url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
} else {
    $url = "https://github.com/astral-sh/uv/releases/download/$Version/uv-x86_64-pc-windows-msvc.zip"
}

$zip = Join-Path $dest "uv.zip"
Write-Host "[fetch-uv] Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip

Write-Host "[fetch-uv] Extracting uv.exe"
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip -Force
# Keep only uv.exe (uvw.exe / uvx.exe are not needed).
Get-ChildItem $dest -Filter "*.exe" |
    Where-Object { $_.Name -ne "uv.exe" } |
    Remove-Item -Force

if (-not (Test-Path (Join-Path $dest "uv.exe"))) {
    throw "[fetch-uv] uv.exe missing after extraction"
}
Write-Host "[fetch-uv] OK -> vendor\uv\uv.exe"
