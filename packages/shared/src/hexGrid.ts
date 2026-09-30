/** Flat-top odd-q grid. Entity x/y are offset column/row; tile q/r are axial. */
export function hexOffsetToAxial(col: number, row: number): { q: number; r: number } {
    return { q: col, r: row - Math.floor(col / 2) };
}

export function hexAxialToOffset(q: number, r: number): { col: number; row: number } {
    return { col: q, row: r + Math.floor(q / 2) };
}

export function hexOffsetToPixel(col: number, row: number, size = 1): { x: number; y: number } {
    return { x: size * 1.5 * col, y: size * Math.sqrt(3) * (row + (col & 1) / 2) };
}

/** Input must already be in map-local coordinates (after camera/SVG transforms). */
export function pixelToHexOffset(x: number, y: number, size = 1): { col: number; row: number } {
    const q = 2 * x / (3 * size);
    const r = (-x / 3 + Math.sqrt(3) * y / 3) / size;
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return hexAxialToOffset(rq || 0, rr || 0);
}
