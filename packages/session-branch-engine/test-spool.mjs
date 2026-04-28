import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { enqueuePhronesisPayload, flushPhronesisSpool } from './phronesis-spool.mjs';
import { createHttpPhronesisMediation } from './phronesis-http-mediation.mjs';

const SPOOL_DIR = path.join(process.cwd(), '.phronesis-spool-test');

await fs.rm(SPOOL_DIR, { recursive: true, force: true });
await fetch('http://127.0.0.1:8788/debug/reset', { method: 'POST' });

const queued = await enqueuePhronesisPayload({
  sessionKey: 'agent:test-spool',
  turnId: 'turn-spool-test-1',
  objective: 'remember concise preference',
  strategy: 'compact',
  confirmedFacts: ['user likes concise replies'],
  decisions: ['prefer concise'],
  completed: [],
  nextActions: ['apply concise style'],
  risks: [],
  health: { tokenRatio: 0.83, qualityDropSignal: false, branchInstability: 1 },
  evidenceRefs: [{ sourceType: 'conversation', conversationId: 'conv1', turnId: 'turn1' }],
  createdAt: new Date().toISOString(),
  candidateHints: { sourceDomain: 'preference_intent', likelySemanticType: 'procedure', pillar: 'reflection', importance: 0.8 },
}, { spoolDir: SPOOL_DIR });
assert.equal(queued.queued, true);

const mediation = createHttpPhronesisMediation({ baseUrl: 'http://127.0.0.1:8788' });
const flushed = await flushPhronesisSpool(mediation, { spoolDir: SPOOL_DIR });
assert.equal(flushed.processed, 1);
assert.equal(flushed.success, 1);
assert.ok(flushed.results[0].merge);
assert.ok(flushed.results[0].merge.semantic_writes.length >= 1);

const state = await fetch('http://127.0.0.1:8788/debug/state').then((r) => r.json());
assert.ok(state.candidates.length >= 1);
assert.ok(state.claims.length >= 1);

console.log('session-branch-engine spool test passed');
