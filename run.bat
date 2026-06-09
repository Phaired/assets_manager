@echo off
REM ---------------------------------------------------------------------------
REM Lance l'app assets_gen (Tauri + React). Cree le venv Python du worker IA au
REM premier lancement, installe les dependances JS, puis demarre l'app desktop.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PYEXE=.venv\Scripts\python.exe"

REM --- venv Python du worker d'inference (multivue OpenAI + Hunyuan + mesh) ---
if not exist "%PYEXE%" (
    echo [assets_gen] Creation du venv worker + dependances Python...
    where uv >nul 2>nul
    if %ERRORLEVEL%==0 (
        uv venv --python 3.11 .venv
        uv pip install --python "%PYEXE%" -r worker\requirements.txt
    ) else (
        py -3.11 -m venv .venv 2>nul || python -m venv .venv
        "%PYEXE%" -m pip install --upgrade pip
        "%PYEXE%" -m pip install -r worker\requirements.txt
    )
)

REM --- dependances JS ---
if not exist "node_modules" (
    echo [assets_gen] Installation des dependances JS...
    where pnpm >nul 2>nul && (pnpm install) || (npm install)
)

echo [assets_gen] Demarrage de l'app desktop (Tauri)...
where pnpm >nul 2>nul && (pnpm tauri dev) || (npm run tauri dev)

endlocal
