# ---------------------------------------------------------------------------
# Builds the TWO Hunyuan3D CUDA extension wheels that no public index ships:
#     custom_rasterizer        (hy3dgen/texgen/custom_rasterizer)
#     differentiable_renderer  (hy3dgen/texgen/differentiable_renderer)
#
# These are the ONLY self-hosted artifacts of the guided installer. You build
# them ONCE on a reference machine, then upload the two .whl to the app's GitHub
# Releases and paste their URLs (+ sha256) into `Recipe::ext_wheels` in
# src-tauri/src/installer.rs. End-user machines never compile anything.
#
# They MUST match the installer's pinned tuple EXACTLY:
#     Python 3.10  +  torch 2.5.1 + cu124  +  win_amd64
# Change any of those => rebuild the wheels AND update the recipe.
#
# Prerequisites on THIS build machine (not on end users):
#   - Visual Studio 2022 Build Tools (MSVC v143, "Desktop development with C++")
#     (the script auto-loads vcvars64; cl.exe need not be on PATH beforehand)
#   - CUDA Toolkit 12.4+ on PATH (12.6 works fine against torch cu124)
#   - uv (or run scripts/fetch-uv.ps1 first and use vendor\uv\uv.exe)
#
#     pwsh scripts/build-extension-wheels.ps1 -RepoZipRef <commit-sha>
# ---------------------------------------------------------------------------
param(
    # Pin the SAME Hunyuan3D-2 commit the installer downloads (Recipe.repo_zip_url).
    [string]$RepoZipRef = "main",
    [string]$PythonVersion = "3.10",
    [string]$TorchIndex = "https://download.pytorch.org/whl/cu124",
    [string[]]$TorchPackages = @("torch==2.5.1", "torchvision==0.20.1"),
    # Broad coverage of consumer GPUs (Turing..Ada). Trim to shrink build time.
    [string]$CudaArchList = "7.5;8.0;8.6;8.9"
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root "build-wheels"
$out  = Join-Path $root "dist-wheels"
New-Item -ItemType Directory -Force -Path $work, $out | Out-Null

# Resolve uv (vendored or on PATH).
$uv = Join-Path $root "vendor\uv\uv.exe"
if (-not (Test-Path $uv)) { $uv = "uv" }

# 1. Fetch the pinned Hunyuan3D-2 source (zipball, no git needed).
$repoZip = Join-Path $work "hunyuan.zip"
$repoUrl = "https://codeload.github.com/Tencent/Hunyuan3D-2/zip/$RepoZipRef"
Write-Host "[wheels] Downloading $repoUrl"
Invoke-WebRequest -Uri $repoUrl -OutFile $repoZip
Expand-Archive -Path $repoZip -DestinationPath $work -Force
$repo = Get-ChildItem $work -Directory | Where-Object { $_.Name -like "Hunyuan3D-2*" } | Select-Object -First 1
if (-not $repo) { throw "[wheels] extracted repo folder not found" }
Write-Host "[wheels] repo: $($repo.FullName)"

# 2. Build venv with the pinned tuple (Python + torch from the cu124 index).
$venv = Join-Path $work ".venv"
& $uv venv --python $PythonVersion $venv
$py = Join-Path $venv "Scripts\python.exe"
& $uv pip install --python $py --index-url $TorchIndex @TorchPackages
# Build deps: pybind11 (differentiable_renderer), torch's BuildExtension uses
# setuptools+ninja; wheel for bdist_wheel.
& $uv pip install --python $py wheel setuptools ninja "pybind11>=2.6.0"

# 2b. Load the MSVC build environment (cl.exe) into this session. setup.py /
# CUDAExtension shell out to cl.exe + nvcc, which are NOT on PATH by default.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "[wheels] vswhere.exe not found - install Visual Studio 2022 (Build Tools, C++ workload)."
}
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "[wheels] no MSVC C++ toolset found (VC.Tools.x86.x64)." }
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
Write-Host "[wheels] Loading MSVC env from $vcvars"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "[wheels] cl.exe still not on PATH after vcvars - check the C++ workload install."
}
# Make ninja (installed in the build venv) discoverable -> faster compiles.
$env:PATH = (Join-Path $venv "Scripts") + ";" + $env:PATH

# 3. Compile each extension into a wheel.
$env:TORCH_CUDA_ARCH_LIST = $CudaArchList
$env:DISTUTILS_USE_SDK = "1"
$exts = @(
    (Join-Path $repo.FullName "hy3dgen\texgen\custom_rasterizer"),
    (Join-Path $repo.FullName "hy3dgen\texgen\differentiable_renderer")
)
foreach ($ext in $exts) {
    if (-not (Test-Path (Join-Path $ext "setup.py"))) {
        Write-Warning "[wheels] no setup.py in $ext (repo layout may differ) - skipping"
        continue
    }
    Write-Host "[wheels] building $ext"
    Push-Location $ext
    # setup.py bdist_wheel (NOT `python -m build`): these extensions import torch
    # in setup.py, so we must build in THIS venv, not an isolated PEP517 env.
    & $py setup.py bdist_wheel --dist-dir $out
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw "[wheels] build failed for $ext" }
}

Write-Host "[wheels] Done. Wheels in: $out"
Write-Host "[wheels] Next: upload them to the app GitHub Release, then set their"
Write-Host "[wheels]       URLs + sha256 in Recipe::ext_wheels (src-tauri/src/installer.rs)."
Get-ChildItem $out -Filter *.whl | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    Write-Host "  $($_.Name)"
    Write-Host "    sha256 = $hash"
}
