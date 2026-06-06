"""Order management module."""

from utils import calculate_total_price, apply_discount


def create_order(customer_id: str, items: list[dict]) -> dict:
    """Create a new order for a customer."""
    # Calculate the total using the utility function
    total = calculate_total_price(items)

    return {
        "customer_id": customer_id,
        "items": items,
        "total": total,
        "status": "pending",
    }


def create_discounted_order(
    customer_id: str, items: list[dict], discount_pct: float
) -> dict:
    """Create an order with a discount applied."""
    # First calculate_total_price, then apply discount
    subtotal = calculate_total_price(items)
    final_total = apply_discount(subtotal, discount_pct)

    return {
        "customer_id": customer_id,
        "items": items,
        "subtotal": subtotal,
        "discount_pct": discount_pct,
        "total": final_total,
        "status": "pending",
    }


def summarize_order(order: dict) -> str:
    """Generate a human-readable summary of an order."""
    # Docstring reference: uses calculate_total_price internally
    return f"Order for {order['customer_id']}: {len(order['items'])} items, total ${order['total']:.2f}"
