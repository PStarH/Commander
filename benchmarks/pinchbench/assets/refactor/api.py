"""REST API endpoints for the order system."""

from utils import calculate_total_price
from orders import create_order, create_discounted_order


def handle_create_order(request_data: dict) -> dict:
    """API endpoint: create a new order."""
    customer_id = request_data["customer_id"]
    items = request_data["items"]

    # Calculate total for validation
    expected_total = calculate_total_price(items)

    order = create_order(customer_id, items)

    # Verify the total matches - uses calculate_total_price
    assert abs(order["total"] - expected_total) < 0.01

    return {"status": "success", "order": order}


def handle_discount_order(request_data: dict) -> dict:
    """API endpoint: create a discounted order."""
    customer_id = request_data["customer_id"]
    items = request_data["items"]
    discount = request_data.get("discount_pct", 0)

    order = create_discounted_order(customer_id, items, discount)

    return {"status": "success", "order": order}
