import assert from 'node:assert/strict';

function normalizeContentParts(content) {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [content];
}

function estimateToolOutputChars(messages = []) {
  let total = 0;
  for (const message of messages) {
    for (const part of normalizeContentParts(message?.content)) {
      if (part?.type === 'toolResult' || part?.type === 'toolCall') {
        total += JSON.stringify(part).length;
      }
    }
  }
  return total;
}

function countToolHeavyTurns(messages = []) {
  let turns = 0;
  for (const message of messages) {
    const hasTool = normalizeContentParts(message?.content).some((part) => part?.type === 'toolResult' || part?.type === 'toolCall');
    if (hasTool) turns += 1;
  }
  return turns;
}

assert.equal(estimateToolOutputChars([{ content: 'hello' }]), 0);
assert.equal(countToolHeavyTurns([{ content: 'hello' }]), 0);
assert.equal(countToolHeavyTurns([{ content: { type: 'toolCall', name: 'x' } }]), 1);
assert.ok(estimateToolOutputChars([{ content: [{ type: 'toolResult', value: { ok: true } }] }]) > 0);

console.log('session-branch-engine message shape test passed');
