#!/bin/bash
# Compila il lettore Navisworks nwd2mbv.exe (NWD/NWC senza Navisworks) in %USERPROFILE%\.mbvisual\nwd\
# Requisiti (winget): BrechtSanders.WinLibs.POSIX.UCRT (g++ e cmake). Si esegue da Git Bash.
set -e
W="$LOCALAPPDATA/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin"
export PATH="$W:$PATH"
SRC=~/.mbvisual/src/nwd-reader
if [ ! -d "$SRC" ]; then
  mkdir -p ~/.mbvisual/src
  git clone --depth 1 https://github.com/1817716374/nwd-reader.git "$SRC"
fi
cmake -S "$SRC" -B "$SRC/build" -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build "$SRC/build" --parallel 8
mkdir -p ~/.mbvisual/nwd
HERE="$(cd "$(dirname "$0")" && pwd)"
g++ -std=c++20 -O2 -municode -I "$SRC/include" "$HERE/nwd2mbv.cpp" \
  "$SRC/build/libnwd_reader.a" "$SRC/build/libnwd_expat.a" "$SRC/build/libnwd_sqlite.a" \
  "$SRC/build/third_party/zlib-1.3.1/libzlibstatic.a" -static -o ~/.mbvisual/nwd/nwd2mbv.exe
echo "creato ~/.mbvisual/nwd/nwd2mbv.exe"
