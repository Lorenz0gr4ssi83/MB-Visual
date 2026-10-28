@echo off
rem Compila stepsplit.exe (divisione dei file STEP grandi per la lettura in parallelo) per ARM64 e x64 con MSVC.
rem Risultato in bin\stepsplit\ (incluso nell'app da tools/build_portable.py con bin\).
setlocal enabledelayedexpansion
set HERE=%~dp0
set OUT=%HERE%..\..\bin\stepsplit
if not exist "%OUT%" mkdir "%OUT%"
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -prerelease -products * -property installationPath`) do set VS=%%i
if not defined VS (echo Visual Studio non trovato & exit /b 1)
set HOSTARCH=amd64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set HOSTARCH=arm64
for %%A in (arm64 x64) do (
  setlocal
  if /i "%%A"=="x64" (set VCARCH=%HOSTARCH%_amd64) else (set VCARCH=%HOSTARCH%_arm64)
  if /i "%HOSTARCH%"=="arm64" if /i "%%A"=="arm64" set VCARCH=arm64
  if /i "%HOSTARCH%"=="amd64" if /i "%%A"=="x64" set VCARCH=amd64
  call "%VS%\VC\Auxiliary\Build\vcvarsall.bat" !VCARCH! >nul
  if not exist "%HERE%obj-%%A" mkdir "%HERE%obj-%%A"
  cl /nologo /O2 /MT /EHsc /std:c++17 /W3 /D_CRT_SECURE_NO_WARNINGS /Fo"%HERE%obj-%%A\\" /Fe"%OUT%\stepsplit-%%A.exe" "%HERE%stepsplit.cpp" || exit /b 1
  endlocal
)
echo Creati %OUT%\stepsplit-arm64.exe e stepsplit-x64.exe
