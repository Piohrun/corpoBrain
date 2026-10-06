@echo off
rem corpoBrain launcher for Windows. Run from the repo root or scripts\.
setlocal
if "%CORPOBRAIN_VAULT%"=="" set "CORPOBRAIN_VAULT=%USERPROFILE%\corpobrain-vault"
if "%CORPOBRAIN_PORT%"=="" set "CORPOBRAIN_PORT=4747"
set "HERE=%~dp0.."
rem Use the Windows certificate store for TLS when this Node supports it
rem (fixes SELF_SIGNED_CERT_IN_CHAIN behind corporate TLS interception).
if not defined NODE_OPTIONS (
  node --use-system-ca -e "0" >nul 2>&1 && set "NODE_OPTIONS=--use-system-ca"
)
if not exist "%CORPOBRAIN_VAULT%\.corpobrain" (
  echo Initializing vault at %CORPOBRAIN_VAULT% ...
  node "%HERE%\dist\corpobrain-cli.js" init --vault "%CORPOBRAIN_VAULT%"
)
echo corpoBrain vault:  %CORPOBRAIN_VAULT%
echo Starting corpoBrain at http://127.0.0.1:%CORPOBRAIN_PORT% ...
rem --open: the server opens the browser itself once it answers, on a loading
rem screen that switches to the app when the vault is ready.
node --disable-warning=ExperimentalWarning "%HERE%\dist\corpobrain.js" "%CORPOBRAIN_VAULT%" --open
endlocal
