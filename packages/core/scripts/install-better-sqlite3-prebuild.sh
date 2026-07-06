#!/usr/bin/env bash
# packages/core/scripts/install-better-sqlite3-prebuild.sh
#
# Downloads the better-sqlite3 prebuilt binary matching the current
# Node ABI/platform/arch and places it where the package will look first.
# Useful when the normal install/prebuild path is blocked (sandboxed CI,
# missing toolchain, network-restricted runners, etc.).
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

BETTER_DIR="$(node -e "console.log(require.resolve('better-sqlite3/package.json').replace('/package.json',''))")"
TARBALL="better-sqlite3-v${VERSION}-node-v${ABI}-${PLATFORM}-${ARCH}.tar.gz"
URL="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/${TARBALL}"

echo "[install-better-sqlite3-prebuild] version=${VERSION} abi=${ABI} platform=${PLATFORM} arch=${ARCH}" >&2

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[install-better-sqlite3-prebuild] downloading ${URL}" >&2
if ! curl -fsSL -o "$TMP_DIR/$TARBALL" "$URL"; then
  echo "[install-better-sqlite3-prebuild] failed to download prebuild (HTTP error or no asset for this combo)" >&2
  exit 1
fi

tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"

mkdir -p "$BETTER_DIR/build/Release"
cp "$TMP_DIR/build/Release/better_sqlite3.node" "$BETTER_DIR/build/Release/better_sqlite3.node"

echo "[install-better-sqlite3-prebuild] installed $BETTER_DIR/build/Release/better_sqlite3.node" >&2
