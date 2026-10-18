#!/usr/bin/env bash
# Builds the Arnis generator for the browser and copies it into web/app.
#
# Needs nightly Rust with rust-src and the wasm32-unknown-emscripten target,
# and an activated Emscripten SDK (source emsdk_env.sh). See web/README.md.
#
#   web/build.sh            optimized build
#   web/build.sh --dev      faster, unoptimized build for debugging
set -euo pipefail
cd "$(dirname "$0")/.."

profile=release
cargo_profile=(--release)
if [[ "${1:-}" == "--dev" ]]; then
  profile=debug
  cargo_profile=()
  shift
fi

cargo "+${RUST_TOOLCHAIN:-nightly}" build "${cargo_profile[@]}" \
  --target wasm32-unknown-emscripten \
  -Zbuild-std=std,panic_unwind \
  "$@"

out=web/app/engine
mkdir -p "$out"
cp "target/wasm32-unknown-emscripten/$profile/arnis.js" "$out/arnis.js"
cp "target/wasm32-unknown-emscripten/$profile/arnis.wasm" "$out/arnis.wasm"
ls -lh "$out"
