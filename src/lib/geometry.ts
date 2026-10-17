type Shape = { x: number; y: number; rotation: number; width?: number; height?: number };

export function bounds(shape: Shape) {
    const width = shape.width ?? 40, height = shape.height ?? 42;
    const angle = shape.rotation * Math.PI / 180;
    const halfWidth = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2;
    const halfHeight = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2;
    const cx = shape.x + width / 2, cy = shape.y + height / 2;
    return { left: cx - halfWidth, right: cx + halfWidth, top: cy - halfHeight, bottom: cy + halfHeight };
}

export function insideCanvas(shape: Shape, width: number, height: number) {
    const b = bounds(shape), tolerance = 1e-7;
    return b.left >= -tolerance && b.top >= -tolerance && b.right <= width + tolerance && b.bottom <= height + tolerance;
}

// Move a desk and its associated seats together without clipping or distorting their offsets.
export function movement(shapes: Shape[], dx: number, dy: number, width: number, height: number) {
    const boxes = shapes.map(bounds);
    return {
        dx: Math.max(-Math.min(...boxes.map(b => b.left)), Math.min(width - Math.max(...boxes.map(b => b.right)), dx)),
        dy: Math.max(-Math.min(...boxes.map(b => b.top)), Math.min(height - Math.max(...boxes.map(b => b.bottom)), dy)),
    };
}
