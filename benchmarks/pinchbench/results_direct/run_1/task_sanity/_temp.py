```python
import os
import json
from datetime import datetime

# Define workspace directory
workspace_dir = "/Users/sampan/Documents/GitHub/Commander/benchmarks/pinchbench/results_direct/run_1/task_sanity"

# Check if workspace directory exists
if not os.path.exists(workspace_dir):
    os.makedirs(workspace_dir)
    print(f"Created workspace directory: {workspace_dir}")

# Define input file paths
input_files = {
    "iris_data.csv": os.path.join(workspace_dir, "iris_data.csv"),
    "stock_data.json": os.path.join(workspace_dir, "stock_data.json")
}

# Check if input files exist
files_exist = all(os.path.exists(path) for path in input_files.values())

if not files_exist:
    print("Input files not found. Creating sample data files...")
    
    # Create Iris dataset (150 rows, 3 species)
    iris_data = """sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
4.7,3.2,1.3,0.2,setosa
4.6,3.1,1.5,0.2,setosa
5.0,3.6,1.4,0.2,setosa
5.4,3.9,1.7,0.4,setosa
4.6,3.4,1.4,0.3,setosa
5.0,3.4,1.5,0.2,setosa
4.4,2.9,1.4,0.2,setosa
4.9,3.1,1.5,0.1,setosa
5.4,3.7,1.5,0.2,setosa
4.8,3.4,1.6,0.2,setosa
4.8,3.0,1.4,0.1,setosa
4.3,3.0,1.1,0.1,setosa
5.8,4.0,1.2,0.2,setosa
5.7,4.4,1.5,0.4,setosa
5.4,3.9,1.3,0.4,setosa
5.1,3.5,1.4,0.3,setosa
5.7,3.8,1.7,0.3,setosa
5.1,3.8,1.5,0.3,setosa
5.4,3.4,1.7,0.2,setosa
5.1,3.7,1.5,0.4,setosa
4.6,3.6,1.0,0.2,setosa
5.1,3.3,1.7,0.5,setosa
4.8,3.4,1.9,0.2,setosa
5.0,3.0,1.6,0.2,setosa
5.0,3.4,1.6,0.4,setosa
5.2,3.5,1.5,0.2,setosa
5.2,3.4,1.4,0.2,setosa
4.7,3.2,1.6,0.2,setosa
4.8,3.1,1.6,0.2,setosa
5.4,3.4,1.5,0.4,setosa
5.2,4.1,1.5,0.1,setosa
5.5,4.2,1.4,0.2,setosa
4.9,3.1,1.5,0.2,setosa
5.0,3.2,1.2,0.2,setosa
5.5,3.5,1.3,0.2,setosa
4.9,3.6,1.4,0.1,setosa
4.4,3.0,1.3,0.2,setosa
5.1,3.4,1.5,0.2,setosa
5.0,3.5,1.3,0.3,setosa
4.5,2.3,1.3,0.3,setosa
4.4,3.2,1.3,0.2,setosa
5.0,3.5,1.6,0.6,setosa
5.1,3.8,1.9,0.4,setosa
4.8,3.0,1.4,0.3,setosa
5.1,3.8,1.6,0.2,setosa
4.6,3.2,1.4,0.2,setosa
5.3,3.7,1.5,0.2,setosa
5.0,3.3,1.4,0.2,setosa
7.0,3.2,4.7,1.4,versicolor
6.4,3.2,4.5,1.5,versicolor
6.9,3.1,4.9,1.5,versicolor
5.5,2.3,4.0,1.3,versicolor
6.5,2.8,4.6,1.5,versicolor
5.7,2.8,4.5,1.3,versicolor
6.3,3.3,4.7,1.6,versicolor
4.9,2.4,3.3,1.0,versicolor
6.6,2.9,4.6,1.3,versicolor
5.2,2.7,3.9,1.4,versicolor
5.0,2.0,3.5,1.0,versicolor
5.9,3.0,4.2,1.5,versicolor
6.0,2.2,4.0,1.0,versicolor
6.1,2.9,4.7,1.4,versicolor
5.6,2.9,3.6,1.3,versicolor
6.7,3.1,4.4,1.4,versicolor
5.6,3.0,4.5,1.5,versicolor
5.8,2.7,4.1,1.0,versicolor
6.2,2.2,4.5,1.5,versicolor
5.6,2.5,3.9,1.1,versicolor
5.9,3.2,4.8,1.8,versicolor
6.1,2.8,4.0,1.3,versicolor
6.3,2.5,4.9,1.5,versicolor
6.1,2.8,4.7,1.2,versicolor
6.4,2.9,4.3,1.3,versicolor
6.6,3.0,4.4,1.4,versicolor
6.8,2.8,4.8,1.4,versicolor
6.7,3.0,5.0,1.7,versicolor
6.0,2.9,4.5,1.5,versicolor
5.7,2.6,3.5,1.0,versicolor
5.5,2.4,3.8,1.1,versicolor
5.5,2.4,3.7,1.0,versicolor
5.8,2.7,3.9,1.2,versicolor
6.0,2.7,5.1,1.6,versicolor
5.4,3.0,4.5,1.5,versicolor
6.0,3.4,4.5,1.6,versicolor
6.7,3.1,4.7,1.5,versicolor
6.3,2.3,4.4,1.3,versicolor
5.6,3.0,4.1,1.3,versicolor
5.5,2.5,4.0,1.3,versicolor
5.5,2.6,4.4,1.2,versicolor
6.1,3.0,4.6,1.4,versicolor
5.8,2.6,4.0,1.2,versicolor
5.0,2.3,3.3,1.0,versicolor
5.6,2.7,4.2,1.3,versicolor
5.7,3.0,4.2,1.2,versicolor
5.7,2.9,4.2,1.3,versicolor
6.2,2.9,4.3,1.3,versicolor
5.1,2.5,3.0,1.1,versicolor
5.7,2.8,4.1,1.3,versicolor
6.3,3.3,6.0,2.5,virginica
5.8,2.7,5.1,1.9,virginica
7.1,3.0,5.9,2.1,virginica
6.3,2.9,5.6,1.8,virginica
6.5,3.0,5.8,2.2,virginica
7.6,3.0,6.6,2.1,virginica
4.9,2.5,4.5,1.7,virginica
7.3,2.9,6.3,1.8,virginica
6.7,2.5,5.8,1.8,virginica
7.2,3.6,6.1,2.5,virginica
6.5,3.2,5.1,2.0,virginica
6.4,2.7,5.3,1.9,virginica
6.8,3.0,5.5,2.1,virginica
5.7,2.5,5.0,2.0,virginica
5.8,2.8,5.1,2.4,virginica
6.4,3.2,5.3,2.3,virginica
6.5,3.0,5.5,1.8,virginica
7.7,3.8,6.7,2.2,virginica
7.7,2.6,6.9,2.3,virginica
6.0,2.2,5.0,1.5,virginica
6.9,3.2,5.7,2.3,virginica
5.6,2.8,4.9,2.0,virginica
7.7,2.8,6.7,2.0,virginica
6.3,2.7,4.9,1.8,virginica
6.7,3.3,5.7,2.1,virginica
7.2,3.2,6.0,1.8,virginica
6.2,2.8,4.8,1.8,virginica
6.1,3.0,4.9,1.8,virginica
6.4,2.8,5.6,2.1,virginica
7.2,3.0,5.8,1.6,virginica
7.4,2.8,6.1,1.9,virginica
7.9,3.8,6.4,2.0,virginica
6.4,2.8,5.6,2.2,virginica
6.3,2.8,5.1,1.5,virginica
6.1,2.6,5.6,1.4,virginica
7.7,3.0,6.1,2.3,virginica
6.3,3.4,5.6,2.4,virginica
6.4,3.1,5.5,1.8,virginica
6.0,3.0,4.8,1.8,virginica
6.9,3.1,5.4,2.1,virginica
6.7,3.1,5.6,2.4,virginica
6.9,3.1,5.1,2.3,virginica
5.8,2.7,5.1,1.9,virginica
6.8,3.2,5.9,2.3,virginica
6.7,3.3,5.7,2.5,virginica
6.7,3.0,5.2,2.3,virginica
6.3,2.5,5.0,1.9,virginica
6.5,3.0,5.2,2.0,virginica
6.2,3.4,5.4,2.3,virginica
5.9,3.0,5.1,1.8,virginica"""
    
    with open(input_files["iris_data.csv"], "w") as f:
        f.write(iris_data)
    print(f"Created Iris dataset: {input_files['iris_data.csv']}")
    
    # Create stock data (Apple 2014)
    stock_data = {
        "company": "Apple Inc.",
        "ticker": "AAPL",
        "year": 2014,
        "start_price": 77.45,
        "end_price": 110.03,
        "change_percent": 42.0,
        "monthly_prices": {
            "Jan": 77.45,
            "Feb": 75.78,
            "Mar": 76.68,
            "Apr": 84.29,
            "May": 90.43,
            "Jun": 92.93,
            "Jul": 95.60,
            "Aug": 102.50,
            "Sep": 100.75,
            "Oct": 108.00,
            "Nov": 118.93,
            "Dec": 110.03
        }
    }
    
    with open(input_files["stock_data.json"], "w") as f:
        json.dump(stock_data, f, indent=2)
    print(f"Created stock data: {input_files['stock_data.json']}")

# Process the data
print("\nProcessing data...")

# Read and analyze Iris data
with open(input_files["iris_data.csv"], "r") as f:
    iris_lines = f.readlines()
    
iris_header = iris_lines[0].strip().split(",")
iris_data = []
for line in iris_lines[1:]:
    if line.strip():
        values = line.strip().split(",")
        iris_data.append(dict(zip(iris_header, values)))

# Count species
species_counts = {}
for row in iris_data:
    species = row["species"]
    species_counts[species] = species_counts.get(species, 0) + 1

print(f"Iris dataset: {len(iris_data)} samples")
print(f"Species distribution: {species_counts}")

# Read and analyze stock data
with open(input_files["stock_data.json"], "r") as f:
    stock_data = json.load(f)

print(f"\nStock data for {stock_data['company']} ({stock_data['ticker']}) in {stock_data['year']}:")
print(f"Start price: ${stock_data['start_price']:.2f}")
print(f"End price: ${stock_data['end_price']:.2f}")
print(f"Change: {stock_data['change_percent']:.1f}%")

# Calculate some statistics
monthly_prices = list(stock_data["monthly_prices"].values())
avg_price = sum(monthly_prices) / len(monthly_prices)
max_price = max(monthly_prices)
min_price = min(monthly_prices)
max_month = [month for month, price in stock_data["monthly_prices"].items() if price == max_price][0]
min_month = [month for month, price in stock_data["monthly_prices"].items() if price == min_price][0]

print(f"Average monthly price: ${avg_price:.2f}")
print(f"Highest price: ${max_price:.2f} in {max_month}")
print(f"Lowest price: ${min_price:.2f} in {min_month}")

# Create output files
print("\nCreating output files...")

# Create analysis report
report_content = f"""Data Analysis Report
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

=== Iris Dataset Analysis ===
Total samples: {len(iris_data)}
Species distribution:
"""
for species, count in species_counts.items():
    report_content += f"- {species}: {count} samples ({count/len(iris_data)*100:.1f}%)\n"

report_content += f"""
=== Apple Stock Analysis ({stock_data['year']}) ===
Ticker: {stock_data['ticker']}
Start price: ${stock_data['start_price']:.2f}
End price: ${stock_data['end_price']:.2f}
Annual change: {stock_data['change_percent']:.1f}%

Monthly Statistics:
- Average price: ${avg_price:.2f}
- Highest price: ${max_price:.2f} ({max_month})
- Lowest price: ${min_price:.2f} ({min_month})
- Price range: ${max_price - min_price:.2f}

Monthly Prices:
"""
for month, price in stock_data["monthly_prices"].items():
    report_content += f"{month}: ${price:.2f}\n"

report_path = os.path.join(workspace_dir, "analysis_report.txt")
with open(report_path, "w") as f:
    f.write(report_content)
print(f"Created analysis report: {report_path