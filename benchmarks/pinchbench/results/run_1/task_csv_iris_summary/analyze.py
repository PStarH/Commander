import csv, math, json
from collections import Counter

rows = []
with open('/Users/sampan/Documents/GitHub/Commander/benchmarks/pinchbench/results/run_1/task_csv_iris_summary/iris_flowers.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        rows.append({
            'sepal_length': float(row['sepal_length']),
            'sepal_width': float(row['sepal_width']),
            'petal_length': float(row['petal_length']),
            'petal_width': float(row['petal_width']),
            'species': row['species']
        })

results = {}

# Basic info
results['total_rows'] = len(rows)
results['columns'] = list(rows[0].keys())
species_counts = dict(Counter(row['species'] for row in rows))
results['species_counts'] = species_counts

numeric_cols = ['sepal_length', 'sepal_width', 'petal_length', 'petal_width']

def mean(vals):
    return sum(vals) / len(vals)

def median(vals):
    s = sorted(vals)
    n = len(s)
    if n % 2 == 0:
        return (s[n//2 - 1] + s[n//2]) / 2
    return s[n//2]

def std_dev(vals):
    m = mean(vals)
    return math.sqrt(sum((v - m)**2 for v in vals) / len(vals))

# Overall statistics
overall = {}
for col in numeric_cols:
    vals = [row[col] for row in rows]
    overall[col] = {
        'mean': round(mean(vals), 4),
        'median': round(median(vals), 4),
        'std': round(std_dev(vals), 4),
        'min': min(vals),
        'max': max(vals)
    }
results['overall'] = overall

# Per-species statistics
per_species = {}
for sp in sorted(species_counts.keys()):
    sp_rows = [r for r in rows if r['species'] == sp]
    per_species[sp] = {}
    for col in numeric_cols:
        vals = [r[col] for r in sp_rows]
        per_species[sp][col] = {
            'mean': round(mean(vals), 4),
            'std': round(std_dev(vals), 4)
        }
results['per_species'] = per_species

# Correlation
def correlation(x, y):
    n = len(x)
    mx = mean(x)
    my = mean(y)
    num = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    den_x = math.sqrt(sum((x[i] - mx)**2 for i in range(n)))
    den_y = math.sqrt(sum((y[i] - my)**2 for i in range(n)))
    return num / (den_x * den_y) if den_x and den_y else 0

corr_results = {}
for i, col1 in enumerate(numeric_cols):
    for j, col2 in enumerate(numeric_cols):
        if i < j:
            vals1 = [row[col1] for row in rows]
            vals2 = [row[col2] for row in rows]
            corr = correlation(vals1, vals2)
            corr_results[f"{col1} vs {col2}"] = round(corr, 4)

results['correlations'] = corr_results

strongest_pair = max(corr_results, key=lambda k: abs(corr_results[k]))
results['strongest_correlation'] = {'pair': strongest_pair, 'r': corr_results[strongest_pair]}

with open('/Users/sampan/Documents/GitHub/Commander/benchmarks/pinchbench/results/run_1/task_csv_iris_summary/results.json', 'w') as f:
    json.dump(results, f, indent=2)

print(json.dumps(results, indent=2))
