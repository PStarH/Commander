"""Utility functions for order processing."""

EXPORTED_FUNCTIONS = ["calculate_total_price", "apply_discount", "format_receipt"]


def calculate_total_price(items: list[dict], tax_rate: float = 0.08) -> float:
    """Calculate the total price for a list of items with tax.

    Each item should have 'price' and 'quantity' keys.
    The tax_rate is applied to the subtotal.
    """
    subtotal = sum(item["price"] * item["quantity"] for item in items)
    tax = subtotal * tax_rate
    total = subtotal + tax
    return round(total, 2)


def apply_discount(total: float, discount_pct: float) -> float:
    """Apply a percentage discount to the total."""
    if not 0 <= discount_pct <= 100:
        raise ValueError("Discount must be between 0 and 100")
    return round(total * (1 - discount_pct / 100), 2)


def format_receipt(total: float, currency: str = "USD") -> str:
    """Format the total as a receipt string."""
    return f"Total: {total:.2f} {currency}"
