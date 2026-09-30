import assert from 'node:assert/strict';
import { hexAxialToOffset, hexOffsetToAxial, hexOffsetToPixel, pixelToHexOffset } from '../packages/shared/src/hexGrid.ts';
import { installDemoContent } from '../packages/backend/src/demo/DemoContent.ts';

for (let col = -10; col <= 10; col++) {
    for (let row = -8; row <= 8; row++) {
        const axial = hexOffsetToAxial(col, row);
        assert.deepEqual(hexAxialToOffset(axial.q, axial.r), { col, row });
        for (const size of [1, 17, 50]) {
            const point = hexOffsetToPixel(col, row, size);
            assert.deepEqual(pixelToHexOffset(point.x, point.y, size), { col, row });
            // Points near all six vertices, but strictly inside this hex.
            for (let corner = 0; corner < 6; corner++) {
                const angle = corner * Math.PI / 3;
                assert.deepEqual(pixelToHexOffset(point.x + .95 * size * Math.cos(angle), point.y + .95 * size * Math.sin(angle), size), { col, row });
            }
        }
    }
}
const map = installDemoContent().map;
assert.ok(map);
const occupied = new Set(map.tiles.map(({ hex }) => {
    const { col, row } = hexAxialToOffset(hex.q, hex.r);
    assert.ok(col >= 0 && col < map.width && row >= 0 && row < map.height);
    return `${col},${row}`;
}));
assert.equal(occupied.size, map.width * map.height);
for (const col of [0, 1, -1]) {
    const axial = hexOffsetToAxial(col, 2);
    const center = hexOffsetToPixel(col, 2);
    for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
        const neighbor = hexAxialToOffset(axial.q + dq, axial.r + dr);
        const point = hexOffsetToPixel(neighbor.col, neighbor.row);
        assert.ok(Math.abs(Math.hypot(point.x - center.x, point.y - center.y) - Math.sqrt(3)) < 1e-10);
    }
}
console.log('Hex grid: offset/axial/pixel round trips, hex hit testing, adjacency and demo map bounds passed.');
