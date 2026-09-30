import assert from 'node:assert/strict';
import { resourcePercent } from '../packages/frontend/src/utils/resourceDisplay.ts';

assert.equal(resourcePercent(25, 100), 25);
assert.equal(resourcePercent(150, 100), 100);
assert.equal(resourcePercent(-10, 100), 0);
assert.equal(resourcePercent(10, 0), 0);
assert.equal(resourcePercent(10, -1), 0);
assert.equal(resourcePercent(undefined, undefined), 0);
assert.equal(resourcePercent(Number.NaN, 100), 0);
assert.equal(resourcePercent(10, Number.POSITIVE_INFINITY), 0);
assert.equal(resourcePercent(Number.POSITIVE_INFINITY, 100), 0);
assert.equal(resourcePercent(0, 100), 0);
console.log('frontend-resource-display: 10 assertions passed');
