import assert from 'node:assert/strict';
import { applyObserveOnly } from './observe-only.mjs';

const decision = { strategy: 'compact' };
const observed = applyObserveOnly(decision, { observeOnly: true });
assert.equal(observed.observeOnly, true);
assert.equal(observed.strategy, 'continue');
assert.equal(observed.recommendedStrategy, 'compact');

const normal = applyObserveOnly(decision, { observeOnly: false });
assert.equal(normal.observeOnly, false);
assert.equal(normal.strategy, 'compact');
assert.equal(normal.recommendedStrategy, 'compact');

console.log('session-branch-engine observe-only test passed');
