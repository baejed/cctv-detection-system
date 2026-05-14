def is_point_in_polygon(point: tuple, polygon: list) -> bool:
    """Ray-casting test. polygon is a list of (x, y) tuples, coordinates normalized 0-1."""
    if len(polygon) < 3:
        return False
    x, y = point
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside
