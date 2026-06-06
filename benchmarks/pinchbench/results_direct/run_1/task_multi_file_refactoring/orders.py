from utils import compute_order_total, apply_discount

class Order:
    def __init__(self, items):
        self.items = items
    
    def get_total(self):
        """Get the total price for this order."""
        return compute_order_total(self.items)
    
    def get_total_with_discount(self, discount_percent):
        """Get the total price with discount applied."""
        total = compute_order_total(self.items)
        return apply_discount(total, discount_percent)
