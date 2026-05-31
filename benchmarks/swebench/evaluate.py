#!/usr/bin/env python3
"""
SWE-bench Evaluation Script for Commander

Wraps the official swebench evaluation harness.

Usage:
    python3 evaluate.py [--predictions predictions.jsonl] [--dataset verified|lite] [--workers 8]

Requirements:
    pip install swebench
"""

import argparse
import json
import os
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Evaluate SWE-bench predictions')
    parser.add_argument('--predictions', type=str, default='results/predictions.jsonl',
                        help='Path to predictions JSONL file')
    parser.add_argument('--dataset', type=str, default='princeton-nlp/SWE-bench_Verified',
                        choices=['princeton-nlp/SWE-bench_Verified', 'SWE-bench/SWE-bench_Lite'],
                        help='Dataset to evaluate against')
    parser.add_argument('--workers', type=int, default=4,
                        help='Number of parallel workers')
    parser.add_argument('--run-id', type=str, default='commander-swebench',
                        help='Run identifier')
    parser.add_argument('--modal', action='store_true',
                        help='Use Modal for cloud evaluation')
    args = parser.parse_args()

    predictions_path = Path(args.predictions)
    if not predictions_path.exists():
        print(f"❌ Predictions file not found: {predictions_path}")
        print(f"   Run the benchmark first: npx tsx run_swebench_commander.ts")
        sys.exit(1)

    # Count predictions
    with open(predictions_path) as f:
        predictions = [json.loads(l) for l in f if l.strip()]
    print(f"📋 Found {len(predictions)} predictions")

    # Check for swebench
    try:
        import swebench
        print(f"✅ swebench version: {swebench.__version__}")
    except ImportError:
        print("❌ swebench not installed. Run: pip install swebench")
        sys.exit(1)

    # Run evaluation
    print(f"\n🚀 Starting evaluation...")
    print(f"   Dataset: {args.dataset}")
    print(f"   Workers: {args.workers}")
    print(f"   Run ID: {args.run_id}")

    cmd = [
        sys.executable, '-m', 'swebench.harness.run_evaluation',
        '--dataset_name', args.dataset,
        '--predictions_path', str(predictions_path),
        '--max_workers', str(args.workers),
        '--run_id', args.run_id,
    ]

    if args.modal:
        cmd.extend(['--modal', 'true', '--parallelism', '10'])

    print(f"\n   Command: {' '.join(cmd)}\n")

    import subprocess
    result = subprocess.run(cmd, capture_output=False)

    if result.returncode == 0:
        print(f"\n✅ Evaluation complete!")
        print(f"   Results: results/{args.run_id}/")
    else:
        print(f"\n❌ Evaluation failed with return code {result.returncode}")
        sys.exit(1)


if __name__ == '__main__':
    main()
