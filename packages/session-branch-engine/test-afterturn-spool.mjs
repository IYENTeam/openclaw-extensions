import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import register from './index.mjs';

const SPOOL_DIR = path.join(process.cwd(), '.phronesis-spool-afterturn-test');
process.env.PHRONESIS_SPOOL_DIR = SPOOL_DIR;

await fs.rm(SPOOL_DIR, { recursive: true, force: true });
await fetch('http://127.0.0.1:8788/debug/reset', { method: 'POST' });

const registrations = [];
register({
  registerContextEngine(id, factory) {
    registrations.push({ id, factory });
  },
});

assert.equal(registrations.length, 1);
const engine = registrations[0].factory({
  observeOnly: true,
  assei: { enabled: false },
  memoryOwn: { apiBase: 'http://127.0.0.1:8788', disableHttp: false },
});

const result = await engine.afterTurn({
  state: { strategy: 'continue', recommendedStrategy: 'compact' },
  sessionKey: 'agent:test-afterturn-spool',
  turnId: 'turn-afterturn-spool-1',
  sourceChannel: 'discord',
  objective: 'verify afterTurn recommended strategy enqueues spool',
  confirmedFacts: ['observeOnly uses recommendedStrategy for ingest'],
  decisions: ['enqueue phronesis payload'],
  completed: [],
  nextActions: ['flush later'],
  risks: [],
  evidenceRefs: [],
  tokenRatio: 0.8,
  qualityDropSignal: false,
  branchInstability: 0,
});

assert.equal(result?.phronesis?.queued, true);
assert.equal(result?.assei?.action, 'disabled');
const names = await fs.readdir(SPOOL_DIR);
assert.equal(names.length, 1);
const raw = await fs.readFile(path.join(SPOOL_DIR, names[0]), 'utf8');
const record = JSON.parse(raw);
assert.equal(record.payload.strategy, 'compact');
assert.equal(record.payload.sessionKey, 'agent:test-afterturn-spool');

console.log('session-branch-engine afterTurn spool test passed');
