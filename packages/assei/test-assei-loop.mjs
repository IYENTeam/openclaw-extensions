import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  maybeRunAssei,
  normalizeAsseiStatus,
} from './assei-loop.mjs';

// --- normalizeAsseiStatus -------------------------------------------------
assert.equal(normalizeAsseiStatus('STATUS: CONTINUE'), 'continue');
assert.equal(normalizeAsseiStatus('blah\nSTATUS: DONE'), 'done');
assert.equal(normalizeAsseiStatus('Some reasoning... STATUS: BLOCKED'), 'blocked');
assert.equal(normalizeAsseiStatus('nope'), null);

// --- Helper: build a fake PluginRuntime.subagent -------------------------
function makeFakeSubagent({ verdicts }) {
  const calls = {
    run: [],
    waitForRun: [],
    getSessionMessages: [],
    deleteSession: [],
  };
  const sessionToVerdict = new Map();
  let runIdCounter = 0;
  return {
    calls,
    async run({ sessionKey, message, model, idempotencyKey, lightContext, deliver }) {
      calls.run.push({ sessionKey, message, model, idempotencyKey, lightContext, deliver });
      runIdCounter += 1;
      const v = verdicts.shift() ?? 'STATUS: DONE';
      sessionToVerdict.set(sessionKey, v);
      return { runId: `run-${runIdCounter}` };
    },
    async waitForRun({ runId, timeoutMs }) {
      calls.waitForRun.push({ runId, timeoutMs });
      return { status: 'ok' };
    },
    async getSessionMessages({ sessionKey, limit }) {
      calls.getSessionMessages.push({ sessionKey, limit });
      const verdictText = sessionToVerdict.get(sessionKey) || '';
      return {
        messages: [
          { role: 'user', content: 'verifier prompt' },
          { role: 'assistant', content: verdictText },
        ],
      };
    },
    async deleteSession({ sessionKey, deleteTranscript }) {
      calls.deleteSession.push({ sessionKey, deleteTranscript });
    },
  };
}

// --- Full flow with subagent mock -----------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-'));
  const stateFile = join(dir, 'state.json');
  const logFile = join(dir, 'loop.log');

  const subagent = makeFakeSubagent({
    verdicts: ['STATUS: CONTINUE', 'STATUS: CONTINUE', 'STATUS: DONE'],
  });
  const spawned = [];
  const deps = {
    subagent,
    spawn(_bin, argv) { spawned.push(argv); return { pid: 12345, unref() {} }; },
  };

  const config = {
    assei: {
      stateFile,
      logFile,
      model: 'apiclient/glm-5.1',
      openclawBin: 'openclaw-test',
      maxContinuesPerSession: 2,
    },
  };

  // Turn 1 — CONTINUE → spawn
  const r1 = await maybeRunAssei({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: [{ role: 'assistant', content: 'reported work and tests passed' }],
    runtimeContext: { workspaceDir: dir },
  }, config, deps);
  assert.equal(r1.action, 'spawn_continue');
  assert.equal(r1.verdict, 'continue');
  assert.equal(subagent.calls.run.length, 1);
  assert.equal(spawned.length, 1);

  // Verifier session keys must be unique per parent + turn
  assert.match(subagent.calls.run[0].sessionKey, /^assei-verifier:session-1:turn-1$/);
  assert.equal(subagent.calls.run[0].model, 'apiclient/glm-5.1');
  assert.match(subagent.calls.run[0].message, /You are Assei/);
  assert.match(subagent.calls.run[0].message, /STATUS: CONTINUE, STATUS: DONE, or STATUS: BLOCKED/);

  // Runtime requires idempotencyKey on every subagent.run; we must always provide one,
  // and it must be stable across same (parent, turn) so afterTurn replays don't double-spawn.
  assert.ok(subagent.calls.run[0].idempotencyKey, 'idempotencyKey is required by runtime');
  assert.match(subagent.calls.run[0].idempotencyKey, /^assei:session-1:turn-1$/);

  // waitForRun + getSessionMessages + deleteSession all called
  assert.equal(subagent.calls.waitForRun.length, 1);
  assert.equal(subagent.calls.getSessionMessages.length, 1);
  assert.equal(subagent.calls.deleteSession.length, 1);
  assert.equal(subagent.calls.deleteSession[0].deleteTranscript, true);

  // Continuation argv shape
  assert.match(spawned[0].join(' '), /^agent --session-id session-1 --message Continue/);

  // Turn 2 — different turnId → CONTINUE again
  const r2 = await maybeRunAssei({
    sessionId: 'session-1',
    turnId: 'turn-2',
    messages: [{ role: 'assistant', content: 'still more to do' }],
    runtimeContext: { workspaceDir: dir },
  }, config, deps);
  assert.equal(r2.action, 'spawn_continue');
  assert.equal(subagent.calls.run.length, 2);
  assert.equal(spawned.length, 2);

  // Turn 2 again — same sig → skip without subagent.run
  const dup = await maybeRunAssei({
    sessionId: 'session-1',
    turnId: 'turn-2',
    messages: [{ role: 'assistant', content: 'still more to do' }],
    runtimeContext: { workspaceDir: dir },
  }, config, deps);
  assert.equal(dup.action, 'skip');
  assert.equal(dup.reason, 'already_processed');
  assert.equal(subagent.calls.run.length, 2, 'no extra subagent run on dedup');

  // Turn 3 — DONE → validated_stop, no spawn
  const r3 = await maybeRunAssei({
    sessionId: 'session-1',
    turnId: 'turn-3',
    messages: [{ role: 'assistant', content: 'final report' }],
    runtimeContext: { workspaceDir: dir },
  }, config, deps);
  assert.equal(r3.action, 'validated_stop');
  assert.equal(r3.verdict, 'done');
  assert.equal(subagent.calls.run.length, 3);
  assert.equal(spawned.length, 2, 'DONE must NOT spawn');

  const log = readFileSync(logFile, 'utf8');
  assert.match(log, /spawn_continue/);
  assert.match(log, /validated_stop/);
}

// --- maxContinuesPerSession cap -------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-cap-'));
  const subagent = makeFakeSubagent({
    verdicts: ['STATUS: CONTINUE', 'STATUS: CONTINUE', 'STATUS: CONTINUE'],
  });
  const spawned = [];
  const deps = { subagent, spawn(_b, argv) { spawned.push(argv); return { pid: 1, unref() {} }; } };
  const capConfig = {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
      model: 'apiclient/glm-5.1',
      maxContinuesPerSession: 1,
    },
  };
  const c1 = await maybeRunAssei({
    sessionId: 'session-cap',
    turnId: 't1',
    messages: [{ role: 'assistant', content: 'go' }],
    runtimeContext: { workspaceDir: dir },
  }, capConfig, deps);
  assert.equal(c1.action, 'spawn_continue');
  const c2 = await maybeRunAssei({
    sessionId: 'session-cap',
    turnId: 't2',
    messages: [{ role: 'assistant', content: 'still going' }],
    runtimeContext: { workspaceDir: dir },
  }, capConfig, deps);
  assert.equal(c2.action, 'blocked');
  assert.equal(c2.reason, 'max_continues_exceeded');
  assert.equal(spawned.length, 1, 'second CONTINUE must hit the cap and NOT spawn');
}

// --- Error path: subagent throws -> action: error -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-err-'));
  const errSubagent = {
    async run() { throw new Error('boom'); },
  };
  const deps = { subagent: errSubagent, spawn() { return { pid: 1, unref() {} }; } };
  const errConfig = {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
      model: 'apiclient/glm-5.1',
    },
  };
  const errResult = await maybeRunAssei({
    sessionId: 'session-err',
    turnId: 'te',
    messages: [{ role: 'assistant', content: 'x' }],
    runtimeContext: { workspaceDir: dir },
  }, errConfig, deps);
  assert.equal(errResult.action, 'error');
  assert.equal(errResult.reason, 'validator_failed');
  assert.match(errResult.error, /boom/);
}

// --- Error path: subagent run returns 'error' status ----------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-runerr-'));
  const failingSubagent = {
    async run() { return { runId: 'r1' }; },
    async waitForRun() { return { status: 'error', error: 'model unavailable' }; },
  };
  const deps = { subagent: failingSubagent, spawn() { return { pid: 1, unref() {} }; } };
  const config = {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
      model: 'apiclient/glm-5.1',
    },
  };
  const result = await maybeRunAssei({
    sessionId: 's-runerr',
    turnId: 't1',
    messages: [{ role: 'assistant', content: 'x' }],
    runtimeContext: { workspaceDir: dir },
  }, config, deps);
  assert.equal(result.action, 'error');
  assert.match(result.error, /model unavailable/);
}

// --- Disabled by config ---------------------------------------------------
{
  const off = await maybeRunAssei(
    { sessionId: 's', messages: [] },
    { assei: { enabled: false } },
  );
  assert.equal(off.action, 'disabled');
}

// --- Missing session ref --------------------------------------------------
{
  const noSession = await maybeRunAssei(
    { messages: [] },
    { assei: { enabled: true } },
    {
      subagent: {
        async run() { throw new Error('should not be called'); },
      },
    },
  );
  assert.equal(noSession.action, 'skip');
  assert.equal(noSession.reason, 'missing_session_ref');
}

// --- No subagent injected -> graceful error -------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-noruntime-'));
  const result = await maybeRunAssei({
    sessionId: 'no-runtime',
    turnId: 't1',
    messages: [{ role: 'assistant', content: 'x' }],
    runtimeContext: { workspaceDir: dir },
  }, {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
    },
  });
  assert.equal(result.action, 'error');
  assert.match(result.error, /PluginRuntime\.subagent API not available/);
}

// --- Model is required: assei.model must be pinned, no silent fallback ----
// Assei is by definition an EXTERNAL verifier. Falling back to whatever the
// main agent uses defeats the purpose, so the verifier must error rather
// than quietly use the same model.
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-nomodel-'));
  const subagent = {
    async run() { throw new Error('subagent.run must not be called when model is missing'); },
  };
  const prevModelEnv = process.env.OPENCLAW_ASSEI_MODEL;
  delete process.env.OPENCLAW_ASSEI_MODEL;
  const result = await maybeRunAssei({
    sessionId: 'no-model-session',
    turnId: 't1',
    messages: [{ role: 'assistant', content: 'x' }],
    runtimeContext: { workspaceDir: dir },
  }, {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
      // model intentionally omitted
    },
  }, { subagent });
  if (prevModelEnv !== undefined) process.env.OPENCLAW_ASSEI_MODEL = prevModelEnv;
  assert.equal(result.action, 'error');
  assert.match(result.error, /assei\.model is required/);
}

// --- Self-recursion guard: don't process Assei's own verifier sessions ----
// When Assei spawns a verifier subagent, that subagent's afterTurn would
// otherwise re-enter maybeRunAssei and cascade infinitely. Verifier sessions
// have a recognizable sessionKey prefix and must short-circuit immediately.
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-assei-recursion-'));
  const subagent = {
    async run() { throw new Error('verifier session must not call subagent.run'); },
  };
  // 1) sessionKey shape produced by openclaw runtime: agent:<agent>:assei-verifier:...
  const r1 = await maybeRunAssei({
    sessionId: 'verifier-session-id',
    sessionKey: 'agent:main:assei-verifier:parent:turn-1',
    messages: [{ role: 'assistant', content: 'STATUS: DONE' }],
    runtimeContext: { workspaceDir: dir },
  }, {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
    },
  }, { subagent, spawn() { return { pid: 1, unref() {} }; } });
  assert.equal(r1.action, 'skip');
  assert.equal(r1.reason, 'verifier_self_session');

  // 2) bare sessionRef starts with assei-verifier: (when sessionKey not provided)
  const r2 = await maybeRunAssei({
    sessionId: 'assei-verifier:parent:turn-2',
    messages: [{ role: 'assistant', content: 'STATUS: DONE' }],
    runtimeContext: { workspaceDir: dir },
  }, {
    assei: {
      stateFile: join(dir, 'state.json'),
      logFile: join(dir, 'loop.log'),
    },
  }, { subagent });
  assert.equal(r2.action, 'skip');
  assert.equal(r2.reason, 'verifier_self_session');
}

console.log('assei loop tests passed');
