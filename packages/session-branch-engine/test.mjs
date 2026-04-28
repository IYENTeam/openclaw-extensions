import assert from "node:assert/strict";
import { deriveSignals, classifyHealth } from "./health.mjs";
import { chooseStrategy } from "./strategy.mjs";

const healthy = deriveSignals({ estimatedTokens: 10_000, effectiveBudget: 100_000 });
assert.equal(chooseStrategy(healthy).strategy, "continue");

const flush = deriveSignals({ estimatedTokens: 80_000, effectiveBudget: 100_000 });
assert.equal(chooseStrategy(flush).strategy, "compact");

const toolHeavy = deriveSignals({
  estimatedTokens: 80_000,
  effectiveBudget: 100_000,
  toolOutputCharsRecent: 50_000,
  toolHeavyTurns: 5,
  recentTurns: 8,
});
assert.equal(chooseStrategy(toolHeavy).strategy, "clear");

const stuck = deriveSignals({
  estimatedTokens: 50_000,
  effectiveBudget: 100_000,
  stuckRunSignal: true,
});
assert.equal(chooseStrategy(stuck).strategy, "rewind");
assert.equal(classifyHealth(stuck).band, "critical");

const errorBurst = deriveSignals({
  estimatedTokens: 0,
  effectiveBudget: 100_000,
  errorRecent: 3,
});
assert.equal(classifyHealth(errorBurst).band, "critical");
assert.equal(chooseStrategy(errorBurst).strategy, "compact");

const subagent = chooseStrategy(healthy, { subagentCandidate: true, explorationHeavy: true });
assert.equal(subagent.strategy, "subagent");

console.log("session-branch-engine tests passed");

const { trimMessagesToBudget, estimateMessagesTokens } = await import('./index.mjs');
const largeMessages = [
  { role: 'system', content: 'keep system' },
  ...Array.from({ length: 60 }, (_, index) => ({ role: 'user', content: `old message ${index} `.repeat(200) })),
  { role: 'user', content: 'latest request' },
];
const trimmed = trimMessagesToBudget(largeMessages, 2_000, { targetRatio: 0.5 });
assert.ok(trimmed.messages.length < largeMessages.length);
assert.equal(trimmed.messages[0].content, 'keep system');
assert.equal(trimmed.messages.at(-1).content, 'latest request');
assert.ok(trimmed.estimatedTokens < estimateMessagesTokens(largeMessages));
