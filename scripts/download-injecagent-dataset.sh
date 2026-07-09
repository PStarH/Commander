#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="${INJECAGENT_CACHE_DIR:-packages/core/.cache/injecagent}"
mkdir -p "$CACHE_DIR"

REPO_URL="https://raw.githubusercontent.com/uiuc-kang-lab/InjecAgent/main/data"

for file in test_cases_dh_base.json test_cases_dh_enhanced.json test_cases_ds_base.json test_cases_ds_enhanced.json; do
  if [ ! -f "$CACHE_DIR/$file" ]; then
    echo "Downloading $file ..."
    curl -fsSL "$REPO_URL/$file" -o "$CACHE_DIR/$file"
  else
    echo "$file already exists, skipping."
  fi
done

echo "InjecAgent dataset cached at $CACHE_DIR"
