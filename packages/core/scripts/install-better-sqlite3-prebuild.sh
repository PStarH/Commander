#!/usr/bin/env bash
# packages/core/scripts/install-better-sqlite3-prebuild.sh
#
# Downloads the better-sqlite3 prebuilt binary matching the current
# Node ABI/platform/arch and places it where the bindings module will
# look first. Useful when the normal install/prebuild path is blocked
# (sandboxed CI, missing toolchain, network-restricted runners, etc.).
#
# Run from packages/core/:
#   bash scripts/install-better-sqlite3-prebuild.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Resolve installed better-sqlite3 version from this package's optional deps.
VERSION="$(node -p "require('./package.json').optionalDependencies['better-sqlite3'] || require('./package.json').dependencies['better-sqlite3'] || ''")"
if [ -z "$VERSION" ]; then
  echo "[install-better-sqlite3-prebuild] better-sqlite3 not found in package.json" >&2
  exit 1
fi
# Strip leading ^/~/
VERSION="${VERSION#[\^~]}"

ABI="$(node -p "process.versions.modules")"
PLATFORM="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"

BETTER_ROOT="$(node -e "console.log(require.resolve('better-sqlite3/package.json').replace('/package.json',''))")"
BUILD_DIR="$BETTER_ROOT/build/Release"
BINDING_DIR="$BETTER_ROOT/lib/binding/node-v${ABI}-${PLATFORM}-${ARCH}"
TARBALL="better-sqlite3-v${VERSION}-node-v${ABI}-${PLATFORM}-${ARCH}.tar.gz"
URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/${TARBALL}"

echo "[install-better-sqlite3-prebuild] version=${VERSION} abi=${ABI} platform=${PLATFORM} arch=${ARCH}" >&2

# Strategy 1: Use npm install --foreground-scripts to let prebuild-install
# download the correct binary. This is the most reliable approach because
# it uses the same mechanism npm uses and respects the package's
# prebuild-install configuration.
TMP_NPM="$(mktemp -d)"
echo "[install-better-sqlite3-prebuild] trying npm install in ${TMP_NPM}" >&2
if (cd "$TMP_NPM" && npm init -y >/dev/null 2>&1 && npm install "better-sqlite3@${VERSION}" --foreground-scripts >/dev/null 2>&1); then
  SRC="$TMP_NPM/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [ -f "$SRC" ]; then
    # Verify the binary loads correctly
    if node -e "require('${SRC}')" 2>/dev/null; then
      echo "[install-better-sqlite3-prebuild] npm prebuild succeeded, installing" >&2
      mkdir -p "$BUILD_DIR" "$BINDING_DIR"
      # Prefer symlink in sandboxed environments; fall back to cp
      ln -sf "$SRC" "$BUILD_DIR/better_sqlite3.node" 2>/dev/null || true
      if [ -L "$BUILD_DIR/better_sqlite3.node" ]; then
        ln -sf "$SRC" "$BINDING_DIR/better_sqlite3.node" 2>/dev/null || true
        echo "[install-better-sqlite3-prebuild] symlinked binary from ${SRC}" >&2
        echo "[install-better-sqlite3-prebuild] OK — binary is ready" >&2
        exit 0
      fi
      cp "$SRC" "$BUILD_DIR/better_sqlite3.node" 2>/dev/null || true
      cp "$SRC" "$BINDING_DIR/better_sqlite3.node" 2>/dev/null || true
      echo "[install-better-sqlite3-prebuild] copied binary from ${SRC}" >&2
      echo "[install-better-sqlite3-prebuild] OK — binary is ready" >&2
      exit 0
    fi
  fi
fi
echo "[install-better-sqlite3-prebuild] npm install approach failed, falling back to manual download" >&2

# Strategy 2: Manual download from GitHub releases.
TMP_DIR="$(mktemp -d)"
echo "[install-better-sqlite3-prebuild] downloading ${URL}" >&2
if ! curl -fsSL -o "$TMP_DIR/$TARBALL" "$URL"; then
  echo "[install-better-sqlite3-prebuild] failed to download prebuild" >&2
  exit 1
fi

tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"

mkdir -p "$BUILD_DIR" "$BINDING_DIR"

# Symlink from the persistent temp directory into the build/Release and
# lib/binding/ directories. Symlinks are preferred over copy because the
# sandbox may block writes to node_modules.
if ln -sf "$TMP_DIR/build/Release/better_sqlite3.node" "$BUILD_DIR/better_sqlite3.node" 2>/dev/null; then
  ln -sf "$TMP_DIR/build/Release/better_sqlite3.node" "$BINDING_DIR/better_sqlite3.node" 2>/dev/null || true
  echo "[install-better-sqlite3-prebuild] symlinked binary to ${BUILD_DIR}" >&2
else
  echo "[install-better-sqlite3-prebuild] failed to install binary" >&2
  exit 1
fi

echo "[install-better-sqlite3-prebuild] OK — binary is ready" >&2