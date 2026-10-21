@echo off
rem Compila mbvshell.dll (miniature e anteprime di Esplora risorse) per ARM64 e x64 con MSVC (Visual Studio o Build Tools,
rem componenti "C++ ARM64" e "C++ x64"). Risultato in bin\shell\ (incluso nell'app da tools/build_portable.py con bin\).
setlocal enabledelayedexpansion
set HERE=%~dp0
set OUT=%HERE%..\..\bin\shell
if not exist "%OUT%" mkdir "%OUT%"
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -prerelease -products * -property installationPath`) do set VS=%%i
if not defined VS (echo Visual Studio non trovato & exit /b 1)
set HOSTARCH=amd64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set HOSTARCH=arm64
set FLAGS=/nologo /O2 /MT /EHsc /std:c++17 /W3 /DUNICODE /D_UNICODE /LD

for %%A in (arm64 x64) do (
  setlocal
  set TARGET=%%A
  if /i "%%A"=="x64" (set VCARCH=%HOSTARCH%_amd64) else (set VCARCH=%HOSTARCH%_arm64)
  if /i "%HOSTARCH%"=="arm64" if /i "%%A"=="arm64" set VCARCH=arm64
  if /i "%HOSTARCH%"=="amd64" if /i "%%A"=="x64" set VCARCH=amd64
  call "%VS%\VC\Auxiliary\Build\vcvarsall.bat" !VCARCH! >nul
  if not exist "%HERE%obj-%%A" mkdir "%HERE%obj-%%A"
  cl %FLAGS% /Fo"%HERE%obj-%%A\\" "%HERE%mbvshell.cpp" /link /DEF:"%HERE%mbvshell.def" /OUT:"%OUT%\mbvshell-%%A.dll" /IMPLIB:"%HERE%obj-%%A\mbvshell.lib" || exit /b 1
  cl /nologo /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fo"%HERE%obj-%%A\\" /Fe"%HERE%obj-%%A\prova.exe" "%HERE%prova.cpp" || exit /b 1
  endlocal
)
del "%OUT%\*.exp" 2>nul
echo Creati %OUT%\mbvshell-arm64.dll e mbvshell-x64.dll
