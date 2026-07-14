#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="packages/core/.cache/harmbench"
mkdir -p "$CACHE_DIR"

URL="https://raw.githubusercontent.com/centerforaisafety/HarmBench/main/data/behavior_datasets/harmbench_behaviors_text_all.csv"
OUT="$CACHE_DIR/harmbench_behaviors_text_all.csv"

if [[ -f "$OUT" ]]; then
  echo "Already cached: $OUT"
else
  echo "Downloading HarmBench behaviors CSV..."
  curl --connect-timeout 30 --max-time 120 -sSL "$URL" -o "$OUT"
fi

echo "HarmBench dataset ready in $CACHE_DIR"
