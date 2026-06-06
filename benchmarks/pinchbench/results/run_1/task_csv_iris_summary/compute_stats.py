import csv
import math
import json

rows = []
with open('iris_flowers.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        rows.append(row)

total_rows = len(rows)
columns = list(rows[0].keys())
numeric_cols = ['sepal_length', 'sepal_width', 'petal_length', 'petal_width']

species_counts = {}
for row in rows:
    sp = row['species']
    species_counts[sp] = species_counts.get(sp, 0) + 1

results = {
    'total_rows': total_rows,
    'columns': columns,
    'species_counts': species_counts,
    'overall': {},
    'per_species': {},
    'correlations': [],
    'strongest': None
}

def compute_stats(data):
    n = len(data)
    mean = sum(data) / n
    sorted_data = sorted(data)
    if n % 2 == 0:
        median = (sorted_data[n//2 - 1] + sorted_data[n//2]) / 2
    else:
        median = sorted_data[n//2]
    variance = sum((x - mean)**2 for x in data) / (n - 1)
    std = math.sqrt(variance)
    return {'mean': mean, 'median': median, 'std': std, 'min': min(data), 'max': max(data)}

for col in numeric_cols:
    data = [float(row[col]) for row in rows]
    results['overall'][col] = compute_stats(data)

species_list = sorted(species_counts.keys())
for sp in species_list:
    sp_rows = [row for row in rows if row['species'] == sp]
    results['per_species'][sp] = {}
    for col in numeric_cols:
        data = [float(row[col]) for row in sp_rows]
        s = compute_stats(data)
        results['per_species'][sp][col] = {'mean': s['mean'], 'std': s['std']}

def pearson_correlation(x, y):
    n = len(x)
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    cov = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n)) / (n - 1)
    std_x = math.sqrt(sum((xi - mean_x)**2 for xi in x) / (n - 1))
    std_y = math.sqrt(sum((yi - mean_y)**2 for yi in y) / (n - 1))
    return cov / (std_x * std_y)

numeric_data = {}
for col in numeric_cols:
    numeric_data[col] = [float(row[col]) for row in rows]

for i in range(len(numeric_cols)):
    for j in range(i+1, len(numeric_cols)):
        col1, col2 = numeric_cols[i], numeric_cols[j]
        r = pearson_correlation(numeric_data[col1], numeric_data[col2])
        results['correlations'].append({'col1': col1, 'col2': col2, 'r': r})

strongest = max(results['correlations'], key=lambda x: abs(x['r']))
results['strongest'] = strongest

with open('stats_results.json', 'w') as f:
    json.dump(results, f, indent=2)

print("Stats computed and saved to stats_results.json")
