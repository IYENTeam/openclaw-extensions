import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import register, { buildAsseiParams } from './index.mjs';

// Helper: build a fake openclaw plugin api with a stub runtime.subagent
function makeFakeApi({ verdict = 'STATUS: DONE' } = {}) {
  const registrations = [];
  const subagentCalls = [];
  const sessionVerdicts = new Map();
  const api = {
    runtime: {
      subagent: {
        async run({ sessionKey, message, model }) {
          subagentCalls.push({ kind: 'run', sessionKey, message, model });
          sessionVerdicts.set(sessionKey, verdict);
          return { runId: `run-${subagentCalls.length}` };
        },
        async waitForRun({ runId, timeoutMs }) {
          subagentCalls.push({ kind: 'waitForRun', runId, timeoutMs });
          return { status: 'ok' };
        },
        async getSessionMessages({ sessionKey }) {
          subagentCalls.push({ kind: 'getSessionMessages', sessionKey });
          return {
            messages: [
              { role: 'user', content: 'verifier prompt' },
              { role: 'assistant', content: sessionVerdicts.get(sessionKey) || '' },
            ],
          };
        },
        async deleteSession({ sessionKey }) {
          subagentCalls.push({ kind: 'deleteSession', sessionKey });
        },
      },
    },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    registerContextEngine(id, factory) {
      registrations.push({ id, factory });
    },
  };
  return { api, registrations, subagentCalls };
}

// --- Test 1: registration shape -------------------------------------------
const { api, registrations } = makeFakeApi();
register(api);

assert.equal(registrations.length, 1, 'should register exactly one context engine');
assert.equal(registrations[0].id, 'assei');

// --- Test 2: engine factory returns the required hook surface --------------
const engine = registrations[0].factory({
  // Disable Assei via config so the test never tries to spawn openclaw.
  // resolveConfig in @iyen/assei treats `enabled: false` as a hard disable.
  enabled: false,
});

assert.equal(engine.info.id, 'assei');
assert.equal(engine.info.ownsCompaction, false);
assert.equal(typeof engine.ingest, 'function');
assert.equal(typeof engine.assemble, 'function');
assert.equal(typeof engine.compact, 'function');
assert.equal(typeof engine.afterTurn, 'function');

// ingest is a no-op
assert.deepEqual(await engine.ingest({ sessionId: 's1', message: { role: 'user', content: 'hi' } }), { ingested: false });

// assemble is a passthrough
const assembleResult = await engine.assemble({
  messages: [{ role: 'user', content: 'hello' }],
  tokenBudget: 1000,
});
assert.equal(assembleResult.messages.length, 1);
assert.equal(typeof assembleResult.estimatedTokens, 'number');

// compact is a no-op claim
const compactResult = await engine.compact({ sessionId: 's1', sessionFile: '/tmp/none' });
assert.equal(compactResult.ok, true);
assert.equal(compactResult.compacted, false);

// --- Test 3: afterTurn with assei disabled is a silent no-op ---------------
const dir = mkdtempSync(join(tmpdir(), 'assei-plugin-test-'));
const result = await engine.afterTurn({
  sessionId: 'ses_test',
  sessionFile: join(dir, 'session.jsonl'),
  messages: [
    { role: 'user', content: 'do X' },
    { role: 'assistant', content: 'done' },
  ],
  prePromptMessageCount: 0,
  tokenBudget: 8000,
  runtimeContext: { workspaceDir: dir },
});
assert.equal(result, undefined, 'afterTurn must be Promise<void> per OpenClaw contract');

// --- Test 4: heartbeat runs are skipped ------------------------------------
let heartbeatHit = false;
const engine2 = registrations[0].factory({
  enabled: true,
  // dryRun + tiny timeouts so even if the guard fails it cant spawn
  dryRun: true,
});
// We rely on the early return: when isHeartbeat=true, maybeRunAssei must NOT
// be invoked. We can't easily inspect that without DI; instead we assert the
// return shape is still void and no exception is thrown.
const hbResult = await engine2.afterTurn({
  sessionId: 'ses_heartbeat',
  sessionFile: join(dir, 'session-hb.jsonl'),
  messages: [{ role: 'assistant', content: 'noop' }],
  prePromptMessageCount: 0,
  isHeartbeat: true,
  runtimeContext: { workspaceDir: dir },
});
assert.equal(hbResult, undefined, 'heartbeat afterTurn must be Promise<void>');

// --- Test 5: buildAsseiParams maps OpenClaw shape -> Assei shape -----------
const mapped = buildAsseiParams({
  sessionId: 'ses_xyz',
  messages: [
    { role: 'user', id: 'm1', content: 'hi' },
    { role: 'assistant', id: 'm2', content: 'hi back' },
  ],
  prePromptMessageCount: 1,
  runtimeContext: { workspaceDir: '/tmp/x' },
});
assert.equal(mapped.sessionId, 'ses_xyz');
assert.equal(mapped.turnId, 'm2', 'turnId should derive from last message id');
assert.equal(mapped.messages.length, 2);
assert.equal(mapped.runtimeContext.workspaceDir, '/tmp/x');

// Empty messages -> falls back to prePromptMessageCount-based id
const mappedEmpty = buildAsseiParams({
  sessionId: 'ses_empty',
  messages: [],
  prePromptMessageCount: 4,
});
assert.match(mappedEmpty.turnId, /^pp-4-len-0$/);

// --- Test 6: afterTurn actually drives runtime.subagent --------------------
{
  const { api: api2, registrations: regs2, subagentCalls } = makeFakeApi({
    verdict: 'STATUS: DONE',
  });
  register(api2);
  const engineWithSub = regs2[0].factory({
    enabled: true,
    dryRun: true,
    model: 'apiclient/glm-5.1',
    stateFile: join(dir, 'with-sub-state.json'),
    logFile: join(dir, 'with-sub.log'),
  });
  await engineWithSub.afterTurn({
    sessionId: 'ses_with_subagent',
    sessionFile: join(dir, 's.jsonl'),
    messages: [
      { role: 'user', content: 'do X' },
      { role: 'assistant', content: 'all done, nothing left' },
    ],
    prePromptMessageCount: 0,
    runtimeContext: { workspaceDir: dir },
  });
  // The subagent must have been driven by assei's verifier flow.
  assert.equal(subagentCalls[0].kind, 'run', 'first call must be subagent.run');
  assert.match(subagentCalls[0].sessionKey, /^assei-verifier:ses_with_subagent:/);
  assert.match(subagentCalls[0].message, /You are Assei/);
  assert.deepEqual(
    subagentCalls.map((c) => c.kind),
    ['run', 'waitForRun', 'getSessionMessages', 'deleteSession'],
    'verifier flow: run -> waitForRun -> getSessionMessages -> deleteSession',
  );

  // Log must record validated_stop (because we returned STATUS: DONE)
  const log = readFileSync(join(dir, 'with-sub.log'), 'utf8');
  assert.match(log, /validated_stop/);
}

// --- Test 7: missing runtime.subagent -> graceful no-op (no crash) --------
{
  const noRuntimeApi = {
    // no runtime here at all
    registerContextEngine(id, factory) {
      noRuntimeApi.factory = factory;
    },
    logger: { warn() {} },
  };
  register(noRuntimeApi);
  const engineNoSub = noRuntimeApi.factory({ enabled: true, stateFile: join(dir, 'no-rt.json') });
  // Should not throw, should silently no-op.
  const r = await engineNoSub.afterTurn({
    sessionId: 'ses_no_rt',
    messages: [{ role: 'assistant', content: 'x' }],
    prePromptMessageCount: 0,
    runtimeContext: { workspaceDir: dir },
  });
  assert.equal(r, undefined);
}

// --- Test 8: model missing -> validator_failed in log, no crash -----------
// Assei is an EXTERNAL verifier; if no model is pinned the plugin must
// surface a clear error in its audit log and continue without spawning the
// verifier (afterTurn contract is Promise<void> so it must NEVER throw).
{
  const { api: api3, registrations: regs3, subagentCalls } = makeFakeApi({});
  register(api3);
  const prevEnv = process.env.OPENCLAW_ASSEI_MODEL;
  delete process.env.OPENCLAW_ASSEI_MODEL;
  const engineNoModel = regs3[0].factory({
    enabled: true,
    stateFile: join(dir, 'no-model-state.json'),
    logFile: join(dir, 'no-model.log'),
    // model intentionally omitted
  });
  const r = await engineNoModel.afterTurn({
    sessionId: 'ses_no_model',
    messages: [{ role: 'assistant', content: 'x' }],
    prePromptMessageCount: 0,
    runtimeContext: { workspaceDir: dir },
  });
  if (prevEnv !== undefined) process.env.OPENCLAW_ASSEI_MODEL = prevEnv;
  assert.equal(r, undefined, 'afterTurn must not throw when model is missing');
  assert.equal(subagentCalls.length, 0, 'subagent.run must NOT be called when model is missing');
  const log = readFileSync(join(dir, 'no-model.log'), 'utf8');
  assert.match(log, /validator_failed/);
  assert.match(log, /assei\.model is required/);
}

console.log('assei plugin tests passed');
