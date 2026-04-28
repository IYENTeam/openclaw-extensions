import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybeRunExternalValidationLoop, normalizeExternalValidationStatus } from './external-validation-loop.mjs';

assert.equal(normalizeExternalValidationStatus('STATUS: CONTINUE'), 'continue');
assert.equal(normalizeExternalValidationStatus('blah\nSTATUS: DONE'), 'done');
assert.equal(normalizeExternalValidationStatus('nope'), null);

const dir = mkdtempSync(join(tmpdir(), 'oc-ext-verify-'));
const stateFile = join(dir, 'state.json');
const logFile = join(dir, 'loop.log');

const spawned = [];
const prompts = [];
const verdicts = ['STATUS: CONTINUE', 'STATUS: CONTINUE', 'STATUS: DONE'];
let validatorCalls = 0;
const deps = {
  async execFileAsync(_bin, argv) {
    validatorCalls += 1;
    assert.deepEqual(argv.slice(0, 4), ['capability', 'model', 'run', '--local']);
    const promptIndex = argv.indexOf('--prompt');
    assert.notEqual(promptIndex, -1);
    prompts.push(argv[promptIndex + 1]);
    return { stdout: JSON.stringify({ outputs: [{ text: verdicts.shift() }] }), stderr: '' };
  },
  spawn(_bin, argv) {
    spawned.push(argv);
    return { pid: 12345, unref() {} };
  },
};

const config = {
  externalValidation: {
    stateFile,
    logFile,
    model: 'test-model',
    openclawBin: 'openclaw-test',
    maxContinuesPerSession: 2,
  },
};

const first = await maybeRunExternalValidationLoop({
  sessionId: 'session-1',
  turnId: 'turn-1',
  messages: [{ role: 'assistant', content: 'reported work and tests passed' }],
  runtimeContext: { workspaceDir: dir },
}, config, deps);
assert.equal(first.action, 'spawn_continue');
assert.equal(validatorCalls, 1);
assert.equal(spawned.length, 1);
assert.doesNotMatch(prompts[0], /status-file/i);
assert.doesNotMatch(prompts[0], /Internal .*state/i);
assert.match(prompts[0], /Recent assistant\/user messages/);
assert.match(spawned[0].join(' '), /Continue the immediately executable next action/);
assert.doesNotMatch(spawned[0].join(' '), /verifier|external|STATUS/i);

const second = await maybeRunExternalValidationLoop({
  sessionId: 'session-1',
  turnId: 'turn-2',
  messages: [{ role: 'assistant', content: 'reported completion but logs show a clear next fix' }],
  runtimeContext: { workspaceDir: dir },
}, config, deps);
assert.equal(second.action, 'spawn_continue');
assert.equal(validatorCalls, 2);
assert.equal(spawned.length, 2);
assert.doesNotMatch(prompts[1], /status-file/i);

const duplicate = await maybeRunExternalValidationLoop({
  sessionId: 'session-1',
  turnId: 'turn-2',
  messages: [{ role: 'assistant', content: 'reported completion but logs show a clear next fix' }],
  runtimeContext: { workspaceDir: dir },
}, config, deps);
assert.equal(duplicate.action, 'skip');
assert.equal(duplicate.reason, 'already_processed');
assert.equal(validatorCalls, 2);

const externalDone = await maybeRunExternalValidationLoop({
  sessionId: 'session-1',
  turnId: 'turn-3',
  messages: [{ role: 'assistant', content: 'final report with no next action' }],
  runtimeContext: { workspaceDir: dir },
}, config, deps);
assert.equal(externalDone.action, 'validated_stop');
assert.equal(externalDone.verdict, 'done');
assert.equal(validatorCalls, 3);
assert.equal(spawned.length, 2);

const log = readFileSync(logFile, 'utf8');
assert.match(log, /spawn_continue/);
assert.match(log, /validated_stop/);
assert.doesNotMatch(log, /internalStatus/);

console.log('external validation loop tests passed');
