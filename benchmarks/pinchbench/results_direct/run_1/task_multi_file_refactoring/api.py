from utils import compute_order_total

def create_order_api(items):
    """API endpoint to create a new order."""
    total = compute_order_total(items)
    return {
        'status': 'success',
        'total': total,
        'message': f'Order created with total ${total:.2f}'
    }

def validate_order(items):
    """Validate order items and calculate total."""
    if not items:
        return {'valid': False, 'error': 'No items provided'}
    
    total = compute_order_total(items)
    return {'valid': True, 'total': total}
