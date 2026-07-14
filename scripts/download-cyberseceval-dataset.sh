#!/usr/bin/env bash
set -euo pipefail

CACHE_DIR="packages/core/.cache/cyberseceval"
mkdir -p "$CACHE_DIR"

BASE_URL="https://raw.githubusercontent.com/meta-llama/PurpleLlama/main/CybersecurityBenchmarks/datasets"

download() {
  local file=$1
  local url="$BASE_URL/$file"
  local out="$CACHE_DIR/$(basename "$file")"
  if [[ -f "$out" ]]; then
    echo "Already cached: $out"
    return
  fi
  echo "Downloading $file..."
  curl --connect-timeout 30 --max-time 120 -sSL "$url" -o "$out"
}

download "mitre/mitre_benchmark_100_per_category_with_augmentation.json"
download "prompt_injection/prompt_injection.json"
download "interpreter/interpreter.json"

echo "CyberSecEval dataset ready in $CACHE_DIR"
