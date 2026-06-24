#!/usr/bin/env python3
"""
One-shot fixup: the apply-besteffort-fixes.ts script wrote
  import { reportSilentFailure } '../silentFailureReporter';
which is missing the `from` keyword. This script rewrites it to
  import { reportSilentFailure } from '../silentFailureReporter';
on every file in the supplied list. Idempotent — no-op if already correct.

Single-use one-shot; safe to delete after this PR.
"""
from pathlib import Path
import re
import sys

FILES = [
    "packages/core/src/atr/compensationQueue.ts",
    "packages/core/src/atr/idempotencyStore.ts",
    "packages/core/src/atr/leaseManager.ts",
    "packages/core/src/atr/runLedger.ts",
    "packages/core/src/runtime/cpuWorkerPool.ts",
    "packages/core/src/sandbox/networkProxy.ts",
    "packages/core/src/tools/_utils/atomicWrite.ts",
    "packages/core/src/tools/webSearchTool.ts",
]
# Matches `import { X } 'PATH';` and captures the path. We require `from `
# NOT to be present already — otherwise idempotency would corrupt lines
# like `} 'from'` later in the path.
PATTERN = re.compile(
    r"^(import\s*\{[^}]*\}\s*)('[^']+';)"
)


def fix(text: str) -> tuple[str, int]:
    out_lines: list[str] = []
    fixed = 0
    for line in text.splitlines(keepends=True):
        stripped = line.rstrip("\n")
        # Already has "from" between } and the path? skip.
        if re.search(r"\}\s*from\s+['\"]", stripped):
            out_lines.append(line)
            continue
        m = PATTERN.match(stripped)
        if not m:
            out_lines.append(line)
            continue
        new_line = f"{m.group(1)}from {m.group(2)}\n"
        out_lines.append(new_line)
        fixed += 1
    return "".join(out_lines), fixed


def main() -> int:
    total_fixed = 0
    for rel in FILES:
        p = Path(rel)
        if not p.exists():
            print(f"MISSING: {rel}", file=sys.stderr)
            return 1
        original = p.read_text(encoding="utf-8")
        new, count = fix(original)
        if count > 0:
            p.write_text(new, encoding="utf-8")
            print(f"OK  {rel}  (+{count} imports)")
            total_fixed += count
        else:
            print(f"--  {rel}  (already correct)")
    print(f"\nTotal imports fixed: {total_fixed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
