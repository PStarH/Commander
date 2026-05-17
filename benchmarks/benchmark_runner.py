"""
Unified Benchmark Runner — single interface for all benchmarks.

Usage:
  python3 benchmark_runner.py <benchmark.yaml> [--output results/] [--model mimo-v2.5-pro]
"""

import json, yaml, sys, os, time, requests
from typing import Optional

def load_config(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)

def run_benchmark(config: dict, model: str = "mimo-v2.5-pro", output_dir: str = "results"):
    bench = config['benchmark']
    name = bench['name']
    os.makedirs(f"{output_dir}/{name}/responses", exist_ok=True)
    
    # Load dataset
    dataset = load_dataset(bench['dataset'], bench.get('format', 'jsonl'))
    
    # Get API key
    with open(os.path.expanduser('~/Documents/GitHub/Commander/.env')) as f:
        env = f.read()
    api_key = [l for l in env.split('\n') if 'OPENAI_API_KEY=' in l][0].split('=')[1].strip()
    
    results = []
    for i, item in enumerate(dataset):
        print(f"[{i+1}/{len(dataset)}] {item.get('task_id', item.get('id', i))} ", end='')
        
        # Build prompt per benchmark type
        prompt = build_prompt(bench, item)
        
        # Call API
        resp = call_model(api_key, model, prompt, bench.get('temperature', 0.2))
        if not resp:
            print("API fail"); continue
        
        # Score
        correct = score_response(bench, item, resp)
        results.append({**item, 'model_response': resp, 'correct': correct})
        print("✅" if correct else "❌")
        
        # Save raw response
        safe_id = item.get('task_id', item.get('id', i)).replace('/', '_')
        with open(f"{output_dir}/{name}/responses/{safe_id}.json", 'w') as f:
            json.dump({"input": item, "output": resp, "correct": correct}, f, indent=2)
    
    summary = {"benchmark": name, "total": len(results), "correct": sum(1 for r in results if r['correct']),
               "accuracy": f"{sum(1 for r in results if r['correct'])/len(results)*100:.1f}%" if results else "N/A"}
    with open(f"{output_dir}/{name}/results.json", 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"\n{name}: {summary['accuracy']}")
    return summary

def load_dataset(path: str, fmt: str):
    if fmt == 'jsonl':
        with open(path) as f:
            return [json.loads(l) for l in f if l.strip()]
    elif fmt == 'json':
        d = json.load(open(path))
        return d if isinstance(d, list) else d.get('data', d.get('questions', []))
    elif fmt == 'csv':
        import csv
        with open(path) as f:
            return list(csv.DictReader(f))
    return []

def build_prompt(bench: dict, item: dict) -> str:
    t = bench.get('type', 'generation')
    if t == 'generation':
        return item.get('prompt', item.get('question', ''))
    elif t == 'chat':
        return item.get('question', item.get('prompt', ''))
    elif t == 'function_calling':
        tools_str = json.dumps(bench.get('tools', []), indent=2)
        return f"Available tools:\n{tools_str}\n\nUser: {item.get('prompt', '')}"
    return item.get('prompt', str(item))

def call_model(api_key: str, model: str, prompt: str, temp: float) -> Optional[str]:
    for _ in range(3):
        try:
            r = requests.post("https://token-plan-sgp.xiaomimimo.com/v1/chat/completions",
                headers={"Content-Type":"application/json","Authorization":f"Bearer {api_key}"},
                json={"model":model,"temperature":temp,"top_p":0.95,"max_tokens":1024,
                    "messages":[{"role":"user","content":prompt[:3000]}],
                    "chat_template_kwargs":{"enable_thinking":False}}, timeout=30)
            r.raise_for_status()
            return r.json()['choices'][0]['message']['content']
        except:
            time.sleep(3)
    return None

def score_response(bench: dict, item: dict, response: str) -> bool:
    expected = str(item.get('answer', item.get('expected', item.get('Final answer', '')))).strip().lower()
    if not expected:
        return bool(response and len(response) > 10)
    mc = response.strip().lower().rstrip('.!? ') if response else ''
    ec = expected.rstrip('.!? ')
    return mc == ec or ec in mc

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('config', help='Benchmark YAML config')
    parser.add_argument('--model', default='mimo-v2.5-pro')
    parser.add_argument('--output', default='/Users/sampan/Documents/GitHub/Commander/benchmarks')
    args = parser.parse_args()
    run_benchmark(load_config(args.config), args.model, args.output)
