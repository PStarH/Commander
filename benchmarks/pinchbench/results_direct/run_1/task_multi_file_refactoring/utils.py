def compute_order_total(items):
    """Calculate the total price of items in an order."""
    total = 0
    for item in items:
        total += item['price'] * item['quantity']
    return total

def apply_discount(total, discount_percent):
    """Apply a discount to the total price."""
    return total * (1 - discount_percent / 100)
