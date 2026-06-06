import csv
import io
import json

csv_text = """Quarter,Product,Region,Revenue,Units_Sold,Profit_Margin
Q1 2025,Widget A,North America,1250000,12500,0.32
Q1 2025,Widget A,Europe,890000,8900,0.28
Q1 2025,Widget A,Asia Pacific,1100000,11000,0.35
Q1 2025,Widget B,North America,780000,7800,0.45
Q1 2025,Widget B,Europe,650000,6500,0.42
Q1 2025,Widget B,Asia Pacific,920000,9200,0.48
Q1 2025,Widget C,North America,450000,4500,0.55
Q1 2025,Widget C,Europe,380000,3800,0.52
Q1 2025,Widget C,Asia Pacific,520000,5200,0.58
Q2 2025,Widget A,North America,1380000,13800,0.33
Q2 2025,Widget A,Europe,950000,9500,0.29
Q2 2025,Widget A,Asia Pacific,1200000,12000,0.36
Q2 2025,Widget B,North America,820000,8200,0.46
Q2 2025,Widget B,Europe,700000,7000,0.43
Q2 2025,Widget B,Asia Pacific,980000,9800,0.49
Q2 2025,Widget C,North America,490000,4900,0.56
Q2 2025,Widget C,Europe,410000,4100,0.53
Q2 2025,Widget C,Asia Pacific,560000,5600,0.59
Q3 2025,Widget A,North America,1500000,15000,0.34
Q3 2025,Widget A,Europe,1020000,10200,0.30
Q3 2025,Widget A,Asia Pacific,1350000,13500,0.37
Q3 2025,Widget B,North America,890000,8900,0.47
Q3 2025,Widget B,Europe,760000,7600,0.44
Q3 2025,Widget B,Asia Pacific,1050000,10500,0.50
Q3 2025,Widget C,North America,530000,5300,0.57
Q3 2025,Widget C,Europe,440000,4400,0.54
Q3 2025,Widget C,Asia Pacific,610000,6100,0.60
Q4 2025,Widget A,North America,1650000,16500,0.35
Q4 2025,Widget A,Europe,1100000,11000,0.31
Q4 2025,Widget A,Asia Pacific,1480000,14800,0.38
Q4 2025,Widget B,North America,950000,9500,0.48
Q4 2025,Widget B,Europe,820000,8200,0.45
Q4 2025,Widget B,Asia Pacific,1120000,11200,0.51
Q4 2025,Widget C,North America,580000,5800,0.58
Q4 2025,Widget C,Europe,480000,4800,0.55
Q4 2025,Widget C,Asia Pacific,660000,6600,0.61"""

reader = csv.DictReader(io.StringIO(csv_text))
rows = list(reader)
for r in rows:
    r['Revenue'] = float(r['Revenue'])
    r['Units_Sold'] = float(r['Units_Sold'])
    r['Profit_Margin'] = float(r['Profit_Margin'])

total_revenue = sum(r['Revenue'] for r in rows)
total_units = sum(r['Units_Sold'] for r in rows)
total_profit = sum(r['Revenue'] * r['Profit_Margin'] for r in rows)

region_rev = {}
for r in rows:
    region_rev[r['Region']] = region_rev.get(r['Region'], 0) + r['Revenue']
top_region = max(region_rev, key=region_rev.get)

product_rev = {}
for r in rows:
    product_rev[r['Product']] = product_rev.get(r['Product'], 0) + r['Revenue']
top_product = max(product_rev, key=product_rev.get)

quarter_rev = {}
for r in rows:
    quarter_rev[r['Quarter']] = quarter_rev.get(r['Quarter'], 0) + r['Revenue']

# Export results as JSON for easy consumption
results = {
    "total_revenue": total_revenue,
    "total_profit": total_profit,
    "total_units": total_units,
    "top_region": top_region,
    "top_region_revenue": region_rev[top_region],
    "top_product": top_product,
    "top_product_revenue": product_rev[top_product],
    "region_rev": region_rev,
    "product_rev": product_rev,
    "quarter_rev": quarter_rev
}

with open("csv_results.json", "w") as f:
    json.dump(results, f, indent=2)

print("CSV Analysis complete. Results saved to csv_results.json")
print(f"Total Revenue: ${total_revenue:,.0f}")
print(f"Total Profit: ${total_profit:,.2f}")
print(f"Total Units Sold: {total_units:,.0f}")
print(f"Top Region: {top_region} (${region_rev[top_region]:,.0f})")
print(f"Top Product: {top_product} (${product_rev[top_product]:,.0f})")
