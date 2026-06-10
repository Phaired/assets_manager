@echo off
REM ---------------------------------------------------------------------------
REM Build complet, "deploiement facile" en une commande :
REM   1) vendorise uv.exe (vendor\uv\uv.exe)      -> embarque pour l'installeur Hunyuan
REM   2) gele le worker Python (PyInstaller)       -> worker_dist\worker\worker.exe
REM   3) construit l'app + l'installeur (Tauri)    -> .exe NSIS + .msi
REM
REM Prerequis : avoir lance run.bat au moins une fois (cree le .venv du worker).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo [release] 1/3 - vendorise uv...
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fetch-uv.ps1
if errorlevel 1 ( echo [release] echec fetch-uv & exit /b 1 )

echo [release] 2/3 - gel du worker Python...
call build-worker.bat
if errorlevel 1 ( echo [release] echec build-worker & exit /b 1 )

echo [release] 3/3 - build de l'installeur Tauri...
where pnpm >nul 2>nul && (pnpm tauri build) || (npm run tauri build)
if errorlevel 1 ( echo [release] echec tauri build & exit /b 1 )

echo [release] OK - installeurs dans src-tauri\target\release\bundle\
endlocal
