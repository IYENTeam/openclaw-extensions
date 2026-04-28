# Session Branch Engine Prototype

OpenClaw context engine prototype for proactive session branching:
- continue
- rewind
- clear
- compact
- subagent

## Files
- `health.mjs` — signal derivation + health banding
- `strategy.mjs` — branch decision engine
- `index.mjs` — OpenClaw context engine registration skeleton
- `test.mjs` — smoke tests for decision logic

## Current status
- Runtime decision core implemented
- OpenClaw context-engine registration skeleton implemented
- Smoke tests passing
- Installed into live OpenClaw config as the context engine slot
- `compact()` currently delegates to OpenClaw runtime
- `rewind` / `clear` / durable-memory side effects are decision-only in v0.1.0
- `afterTurn()` now supports HTTP mediation into MemoryOwn-compatible endpoints
- `afterTurn()` also runs the external validation loop: recent turn evidence is checked by an external model and, only if confirmed actionable, re-enters the same OpenClaw session.
- Default endpoint base URL: `http://127.0.0.1:8788`
- Set `PHRONESIS_DISABLE_HTTP=1` to force local noop mediation fallback
- `observeOnly: true` preserves recommendation/telemetry while forcing runtime strategy to `continue`

## Test
```bash
cd /Users/iyen/.openclaw/workspace/openclaw-runtime/session-branch-engine
node test.mjs
node test-observe-only.mjs
node test-spool.mjs
node test-external-validation-loop.mjs
```

## External validation loop

When the context engine is installed as the `contextEngine` slot, every `afterTurn()` asks an external verifier whether another immediately executable action remains. The inner model's job is only to do the work and report; it does not need to know this loop exists. User-visible replies should not append status tags.

- Verifier input: recent turn evidence only.
- External verifier returns `CONTINUE`: spawn `openclaw agent --session-id <same-session>` with a neutral continuation prompt.
- External verifier returns `DONE` / `BLOCKED`: record stop state, do not continue.
- Deduplication: turn id/run id/message evidence hash + session id is tracked in `.openclaw/external-validation-loop.json`.
- Safety cap: defaults to 8 externally verified continuations per session.

Config/env knobs:
- `externalValidation.enabled` or `OPENCLAW_EXTERNAL_VALIDATION=0`
- `externalValidation.model` or `OPENCLAW_EXTERNAL_VALIDATOR_MODEL` (default `closedrouter-zai/glm-5.1`)
- `externalValidation.maxContinuesPerSession` or `OPENCLAW_EXTERNAL_VALIDATION_MAX_CONTINUES`
- `externalValidation.dryRun` or `OPENCLAW_EXTERNAL_VALIDATION_DRY_RUN=1`

## HTTP mediation quick test
```bash
cd /Users/iyen/.openclaw/workspace/openclaw-runtime/session-branch-engine
node --input-type=module -e '
import { createHttpPhronesisMediation } from "./phronesis-http-mediation.mjs";
const mediation = createHttpPhronesisMediation({ baseUrl: "http://127.0.0.1:8788" });
const result = await mediation.ingestTurnSummary({
  sessionKey: "agent:test",
  turnId: "turn-1",
  objective: "remember concise preference",
  strategy: "compact",
  confirmedFacts: ["user likes concise replies"],
  decisions: ["prefer concise"],
  completed: [],
  nextActions: ["apply concise style"],
  risks: [],
  health: { tokenRatio: 0.8, qualityDropSignal: false, branchInstability: 1 },
  evidenceRefs: [{ sourceType: "conversation", conversationId: "conv1", turnId: "turn1" }],
  createdAt: new Date().toISOString(),
  candidateHints: { sourceDomain: "preference_intent", likelySemanticType: "procedure" }
});
console.log(result);
'
```

## Next integration step
1. Install this as a local OpenClaw plugin bundle
2. Select `plugins.slots.contextEngine = "session-branch-engine"`
3. Start with observe-only mode
4. Async spool + worker handoff implemented for ingest path
5. Flush worker can auto-merge approved candidates into claims
6. Add real clear/rewind/session-state persistence
7. Add merge/review automation policy beyond the current minimal reviewer
