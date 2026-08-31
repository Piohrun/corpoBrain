@echo off
rem corpoBrain launcher for Windows. Run from the repo root or scripts\.
setlocal
if "%CORPOBRAIN_VAULT%"=="" set "CORPOBRAIN_VAULT=%USERPROFILE%\corpobrain-vault"
if "%CORPOBRAIN_PORT%"=="" set "CORPOBRAIN_PORT=4747"
set "HERE=%~dp0.."
if not exist "%CORPOBRAIN_VAULT%\.corpobrain" (
  echo Initializing vault at %CORPOBRAIN_VAULT% ...
  node "%HERE%\dist\corpobrain-cli.js" init --vault "%CORPOBRAIN_VAULT%"
)
echo corpoBrain vault:  %CORPOBRAIN_VAULT%
echo Opening http://127.0.0.1:%CORPOBRAIN_PORT% ...
start "" "http://127.0.0.1:%CORPOBRAIN_PORT%"
node --disable-warning=ExperimentalWarning "%HERE%\dist\corpobrain.js" "%CORPOBRAIN_VAULT%"
endlocal
