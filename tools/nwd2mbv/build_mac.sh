#!/bin/bash
# Compila il lettore Navisworks nwd2mbv per macOS in ~/.mbvisual/nwd/nwd2mbv (lo usa tools/build_mac.py).
# Requisiti: Xcode Command Line Tools (clang++) e cmake (brew install cmake; sui runner GitHub c'e' gia').
set -e
# nwd-reader usa std::jthread: con la libc++ di Apple serve -fexperimental-library (Xcode 16 o successivo)
XFLAGS="-fexperimental-library"
SRC=~/.mbvisual/src/nwd-reader
if [ ! -d "$SRC" ]; then
  mkdir -p ~/.mbvisual/src
  git clone --depth 1 https://github.com/1817716374/nwd-reader.git "$SRC"
fi
cmake -S "$SRC" -B "$SRC/build-mac" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 -DCMAKE_CXX_FLAGS="$XFLAGS"
cmake --build "$SRC/build-mac" --parallel 8
mkdir -p ~/.mbvisual/nwd
HERE="$(cd "$(dirname "$0")" && pwd)"
B="$SRC/build-mac"
ZLIB="$(find "$B" -name 'libzlibstatic.a' -o -name 'libz.a' | head -1)"
clang++ -std=c++20 -O2 $XFLAGS -mmacosx-version-min=12.0 -I "$SRC/include" "$HERE/nwd2mbv.cpp" \
  "$B/libnwd_reader.a" "$B/libnwd_expat.a" "$B/libnwd_sqlite.a" ${ZLIB:+"$ZLIB"} -o ~/.mbvisual/nwd/nwd2mbv
echo "creato ~/.mbvisual/nwd/nwd2mbv"
