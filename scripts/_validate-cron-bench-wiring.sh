#!/bin/bash
# Day 7 closeout: validate the chaos-bench + gaia-bench cron wiring.
# Mirrors the validation we run in CODEOWNERS for the cron matrix.
set +e
cd /Users/sampan/Documents/GitHub/Commander

echo "===== STEP 1: typecheck packages/core ====="
(cd packages/core && npx tsc --noEmit 2>&1 | head -10)
echo "tsc-exit=$?"

echo ""
echo "===== STEP 2: GAIA --quick --output writes valid JSON ====="
rm -f /tmp/gaia.json
npx tsx scripts/benchmark-gaia.ts --quick --output=/tmp/gaia.json > /dev/null 2>&1
echo "gaia-exit=$?"
echo "--- /tmp/gaia.json shape ---"
python3 - << 'PYEOF'
import json, os
p = '/tmp/gaia.json'
if not os.path.exists(p) or os.path.getsize(p) == 0:
    print('MISSING or EMPTY:', p)
else:
    with open(p) as f:
        d = json.load(f)
    print('top keys:', list(d.keys()))
    print('summary keys:', list(d['summary'].keys()))
    print('passed=', d['passed'], '| exitCode=', d['exitCode'], '| failedReason=', d['failedReason'])
    print('summary:', json.dumps(d['summary'], indent=2))
    print('durationMs:', d['durationMs'])
PYEOF

echo ""
echo "===== STEP 3: regression - GAIA --quick without --output works same ====="
npx tsx scripts/benchmark-gaia.ts --quick > /dev/null 2>&1
echo "baseline-exit=$?"

echo ""
echo "===== STEP 4: chaos-runner --simulated --scripted --output ====="
rm -f /tmp/test-chaos.json
npx tsx benchmarks/chaos-runner/src/index.ts run --simulated --scripted --output=/tmp/test-chaos.json > /tmp/chaos-stdout.log 2>&1
echo "chaos-exit=$?"
tail -8 /tmp/chaos-stdout.log
echo "--- /tmp/test-chaos.json shape ---"
python3 - << 'PYEOF'
import json, os
p = '/tmp/test-chaos.json'
if not os.path.exists(p) or os.path.getsize(p) == 0:
    print('MISSING or EMPTY:', p)
else:
    with open(p) as f:
        d = json.load(f)
    print('summary keys:', list(d['summary'].keys()))
    print('summary:', json.dumps(d['summary'], indent=2))
    print('case_results:', len(d.get('case_results', [])), 'cases')
    print('dimension_scores:', d.get('dimension_scores'))
PYEOF

echo ""
echo "===== STEP 5: parse new YAMLs ====="
python3 - << 'PYEOF'
import yaml
for f in ['.github/workflows/chaos-bench.yml', '.github/workflows/gaia-bench.yml']:
    with open(f) as fh:
        d = yaml.safe_load(fh)
    on = d.get(True) if True in d else d.get('on', {})
    if not isinstance(on, dict):
        on = {}
    cron = on.get('schedule', [])
    if not isinstance(cron, list):
        cron = []
    inputs = on.get('workflow_dispatch', {}).get('inputs', {}) if isinstance(on.get('workflow_dispatch'), dict) else {}
    print(f"--- {f} ---")
    print(f"  name: {d.get('name')}")
    print(f"  cron: {[s.get('cron') if isinstance(s, dict) else s for s in cron]}")
    print(f"  inputs: {list(inputs.keys())}")
    print(f"  jobs: {list(d.get('jobs', {}).keys())}")
PYEOF

echo ""
echo "===== STEP 6: full cron matrix summary ====="
for f in .github/workflows/*-bench.yml; do
  cron=$(grep -oE "cron: '[^']+'" "$f" | head -1)
  name=$(grep -E '^name:' "$f" | head -1 | sed -E 's/name: //')
  printf "  %-58s | %-46s | %s\n" "$f" "$name" "$cron"
done

echo ""
echo "===== STEP 7: docs updates verification ====="
echo "-- ENTERPRISE_READINESS.md BENCH-CAP rows --"
grep -nE 'BENCH-CAP|Capability benchmarks' ENTERPRISE_READINESS.md | head -5
echo "-- docs/status.json new items --"
grep -nE 'chaosBench.cronGate|gaiaBench.cronGate' docs/status.json
echo ""
echo "===== ALL CHECKS COMPLETE ====="
