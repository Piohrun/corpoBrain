@echo off
rem corpoBrain benchmark on this machine with your vault. Read-only for the
rem vault: it works on a temporary copy and writes a JSON report (counts and
rem timings only) to the current folder. Extra options are passed through,
rem e.g.  scripts\bench.cmd --with-jira
setlocal
if "%CORPOBRAIN_VAULT%"=="" set "CORPOBRAIN_VAULT=%USERPROFILE%\corpobrain-vault"
set "HERE=%~dp0.."
if not defined NODE_OPTIONS (
  node --use-system-ca -e "0" >nul 2>&1 && set "NODE_OPTIONS=--use-system-ca"
)
node --disable-warning=ExperimentalWarning "%HERE%\dist\corpobrain-bench.js" --vault "%CORPOBRAIN_VAULT%" %*
endlocal
