#!/usr/bin/env bash
# Count lines of code in the project
# Usage: bash count-loc.sh [directory]

DIR="${1:-.}"

# Directories to skip
SKIP="node_modules|.git|dist|build|coverage|__pycache__|.cache|vendor|target|.commander|.sisyphus|.claude|.codex|memory|apps|.commander_"

echo "============================================"
echo " Lines of Code — $(realpath "$DIR")"
echo "============================================"
printf "%-12s %8s %8s %8s\n" "Extension" "Lines" "Blanks" "Files"
echo "--------------------------------------------"

total_lines=0
total_files=0
total_blank=0

for ext in ts js tsx jsx mjs cjs sh py go rs java c cpp h html css scss yaml yml toml json md sql; do
  result=$(find "$DIR" -type f -name "*.$ext" | grep -Ev "($SKIP)" | while read f; do wc -l "$f" 2>/dev/null; done)
  [ -z "$result" ] && continue

  count=$(echo "$result" | wc -l)
  lines=$(echo "$result" | awk '{s+=$1} END{print s}')
  blank=$(find "$DIR" -type f -name "*.$ext" | grep -Ev "($SKIP)" | xargs grep -c '^[[:space:]]*$' 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')

  printf "%-12s %8d %8d %8d\n" ".$ext" "$lines" "$blank" "$count"
  total_lines=$((total_lines + lines))
  total_files=$((total_files + count))
  total_blank=$((total_blank + blank))
done

echo "--------------------------------------------"
printf "%-12s %8d %8d %8d\n" "TOTAL" "$total_lines" "$total_blank" "$total_files"
code=$((total_lines - total_blank))
echo ""
echo "Code lines (excl blanks): $code"
