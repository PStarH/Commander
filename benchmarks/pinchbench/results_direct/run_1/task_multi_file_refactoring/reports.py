from utils import compute_order_total

def generate_order_report(orders):
    """Generate a report of all orders."""
    report = []
    for order in orders:
        total = compute_order_total(order['items'])
        report.append({
            'order_id': order['id'],
            'total': total,
            'item_count': len(order['items'])
        })
    return report

def print_report_summary(report):
    """Print a summary of the order report."""
    print("Order Report Summary:")
    for entry in report:
        print(f"Order {entry['order_id']}: ${entry['total']:.2f} ({entry['item_count']} items)")
