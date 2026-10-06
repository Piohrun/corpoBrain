@echo off
rem One-time setup for the Outlook sync: a private Python environment for
rem corpoBrain with comtypes, made with uv. Run from the repo root or scripts\.
rem The app finds .venv next to dist\ on its own; no Python path to configure.
setlocal
set "HERE=%~dp0.."
where uv >nul 2>&1 || (
  echo uv was not found on PATH. Install uv first, or create a venv with comtypes yourself
  echo and set its python.exe in Settings ^> Outlook.
  exit /b 1
)
rem --system-certs: trust the Windows certificate store (corporate TLS interception).
if not exist "%HERE%\.venv\Scripts\python.exe" (
  echo Creating %HERE%\.venv ...
  uv venv "%HERE%\.venv" --system-certs || exit /b 1
)
echo Installing comtypes ...
uv pip install --python "%HERE%\.venv\Scripts\python.exe" --system-certs "comtypes>=1.4" || exit /b 1
"%HERE%\.venv\Scripts\python.exe" -c "import comtypes.client; print('comtypes OK')" || exit /b 1
echo.
echo Done. Restart corpoBrain, then Settings ^> Outlook ^> Test connection.
endlocal
