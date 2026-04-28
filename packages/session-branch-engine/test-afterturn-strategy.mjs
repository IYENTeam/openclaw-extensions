import assert from 'node:assert/strict';

function resolveAfterTurnStrategy(params = {}) {
  return params?.state?.recommendedStrategy ?? params?.state?.strategy ?? 'continue';
}

assert.equal(resolveAfterTurnStrategy({ state: { strategy: 'continue', recommendedStrategy: 'compact' } }), 'compact');
assert.equal(resolveAfterTurnStrategy({ state: { strategy: 'rewind' } }), 'rewind');
assert.equal(resolveAfterTurnStrategy({}), 'continue');

console.log('session-branch-engine afterTurn strategy test passed');
