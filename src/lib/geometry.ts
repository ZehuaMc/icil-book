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

export function snapMovement(shapes: Shape[], targets: Shape[], dx: number, dy: number, width: number, height: number, threshold = 12) {
    const bounded = movement(shapes, dx, dy, width, height);
    const moving = shapes.map(bounds), others = targets.map(bounds);
    const xCandidates: { delta: number; guide: number }[] = [], yCandidates: { delta: number; guide: number }[] = [];
    const xPoints = (b: ReturnType<typeof bounds>) => [b.left, (b.left + b.right) / 2, b.right];
    const yPoints = (b: ReturnType<typeof bounds>) => [b.top, (b.top + b.bottom) / 2, b.bottom];
    for (const a of moving) for (const b of others) {
        for (const ax of xPoints(a)) for (const bx of xPoints(b)) xCandidates.push({ delta: bx - (ax + bounded.dx), guide: bx });
        for (const ay of yPoints(a)) for (const by of yPoints(b)) yCandidates.push({ delta: by - (ay + bounded.dy), guide: by });
    }
    const x = xCandidates.filter(c => Math.abs(c.delta) <= threshold).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    const y = yCandidates.filter(c => Math.abs(c.delta) <= threshold).sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
    const snapped = movement(shapes, bounded.dx + (x?.delta ?? 0), bounded.dy + (y?.delta ?? 0), width, height);
    return { ...snapped, guideX: x ? x.guide : undefined, guideY: y ? y.guide : undefined };
}
