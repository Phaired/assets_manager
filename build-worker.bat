@echo off
REM ---------------------------------------------------------------------------
REM Gele le worker Python en un dossier autonome (worker_dist\worker\worker.exe)
REM via PyInstaller, pour qu'il soit embarque dans l'installeur Tauri et tourne
REM SANS Python installe sur le PC cible.
REM
REM A lancer depuis la racine du projet, AVANT `pnpm tauri build`.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PYEXE=.venv\Scripts\python.exe"

if not exist "%PYEXE%" (
    echo [build-worker] venv introuvable. Lance d'abord run.bat pour le creer.
    exit /b 1
)

echo [build-worker] Installation de PyInstaller + deps worker dans le venv...
where uv >nul 2>nul
if %ERRORLEVEL%==0 (
    uv pip install --python "%PYEXE%" pyinstaller -r worker\requirements.txt
) else (
    "%PYEXE%" -m pip install --upgrade pyinstaller
    "%PYEXE%" -m pip install -r worker\requirements.txt
)

echo [build-worker] Gel du worker (PyInstaller, one-folder)...
"%PYEXE%" -m PyInstaller worker\worker.spec --noconfirm ^
    --distpath worker_dist --workpath worker_build

if not exist "worker_dist\worker\worker.exe" (
    echo [build-worker] ECHEC : worker_dist\worker\worker.exe absent.
    exit /b 1
)

echo [build-worker] OK -^> worker_dist\worker\worker.exe
echo [build-worker] Tu peux maintenant lancer: pnpm tauri build
endlocal
