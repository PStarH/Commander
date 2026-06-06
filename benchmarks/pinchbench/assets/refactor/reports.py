"""Reporting module for sales analytics."""

from utils import calculate_total_price


def generate_daily_report(orders: list[dict]) -> dict:
    """Generate a daily sales report from a list of orders.

    Uses calculate_total_price to verify order totals.
    """
    total_revenue = 0
    for order in orders:
        # Recalculate to verify
        verified_total = calculate_total_price(order["items"])
        total_revenue += verified_total

    return {
        "order_count": len(orders),
        "total_revenue": total_revenue,
        "average_order": total_revenue / len(orders) if orders else 0,
    }


def generate_monthly_summary(daily_reports: list[dict]) -> dict:
    """Aggregate daily reports into a monthly summary."""
    total_revenue = sum(r["total_revenue"] for r in daily_reports)
    total_orders = sum(r["order_count"] for r in daily_reports)

    return {
        "total_orders": total_orders,
        "total_revenue": total_revenue,
        "daily_average": total_revenue / len(daily_reports) if daily_reports else 0,
    }
