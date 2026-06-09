@echo off
REM ---------------------------------------------------------------------------
REM Lance l'app assets_gen : cree le venv au premier lancement, installe les
REM dependances, demarre le serveur FastAPI et ouvre le navigateur.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PYEXE=.venv\Scripts\python.exe"

if not exist "%PYEXE%" (
    echo [assets_gen] Creation du venv + installation des dependances...
    where uv >nul 2>nul
    if %ERRORLEVEL%==0 (
        REM Chemin uv : le venv n'a pas pip, on installe via "uv pip".
        uv venv --python 3.11 .venv
        uv pip install --python "%PYEXE%" -r requirements.txt
    ) else (
        REM Chemin venv standard : pip est present.
        py -3.11 -m venv .venv 2>nul || python -m venv .venv
        "%PYEXE%" -m pip install --upgrade pip
        "%PYEXE%" -m pip install -r requirements.txt
    )
)

echo [assets_gen] Demarrage sur http://localhost:8799
start "" http://localhost:8799
"%PYEXE%" -m uvicorn app.main:app --host 127.0.0.1 --port 8799

endlocal
