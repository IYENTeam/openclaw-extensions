# @iyen/session-branch-engine

OpenClaw context-engine plugin. After every agent turn, picks one of:

- `continue` — healthy, do nothing
- `compact` — token pressure, summarize history
- `clear` — tool-output bomb, drop messages
- `rewind` — branch instability, return to last solid node
- `subagent` — heavy exploration, fork to subagent

Optionally drives [`@iyen/assei`](../assei) (autonomous turn continuation) and
ingests turn summaries into a Phronesis long-term memory service.

- Plugin id: **`session-branch-engine`**
- Slot: **`contextEngine`**
- Status in v0.1.0: decision logic complete; `compact()` delegates to runtime; `rewind` / `clear` / durable-memory side effects are decision-only.
- Side effects per turn: optional Phronesis HTTP ingest (default `http://127.0.0.1:8788`, async spool); optional Assei verifier loop (writes `.openclaw/assei.{json,log}`).

---

## Install (for agents)

> Read the **root [README](../../README.md)** first if you have not picked
> a package yet. Below assumes the user wants smart context strategy
> (compact/rewind/clear/subagent), with or without autonomous continuation.

### 1. Link the plugin

```bash
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only
openclaw plugins install --link "$REPO/packages/session-branch-engine"
```

### 2. Patch `~/.openclaw/openclaw.json`

Make a backup, then merge:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s)
```

```jsonc
{
  "plugins": {
    "slots": { "contextEngine": "session-branch-engine" },
    "allow": ["session-branch-engine"],
    "entries": {
      "session-branch-engine": {
        "enabled": true,
        "observeOnly": true,
        "softThreshold": 0.6,
        "flushThreshold": 0.75,
        "emergencyThreshold": 0.85,
        "assei": {
          "enabled": true
          // Optional: pin a verifier-only model.
          // "model": "openai/gpt-5-mini"
        }
      }
    }
  }
}
```

> `observeOnly: true` is the recommended starting state: the engine emits
> recommendations and telemetry but forces the runtime strategy to
> `continue`, so it cannot break the user's session while you tune.

### 3. Verify

```bash
openclaw plugins list | grep -E '^.*session-branch-engine.*loaded'
openclaw plugins doctor
openclaw gateway restart 2>/dev/null \
  || pkill -f 'openclaw gateway run' \
  || echo "(start the gateway manually next time you need it)"
```

### Don'ts (agent rules)

- Do **not** also bind `assei` directly to `plugins.slots.contextEngine`. session-branch-engine already drives assei via its `entries.session-branch-engine.assei` block; binding both fights for the same slot.
- Do **not** disable `observeOnly` on first install unless the user explicitly asks for active mutation.
- Do **not** edit unrelated keys in `~/.openclaw/openclaw.json`.
- The Phronesis HTTP ingest path defaults to `http://127.0.0.1:8788`. If the user does **not** run a Phronesis service, set `phronesis.disableHttp: true` (or env `PHRONESIS_DISABLE_HTTP=1`) so the engine falls back to local no-op mediation.

---

## Configuration reference

`plugins.entries.session-branch-engine.*`:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master enable. |
| `observeOnly` | `false` | Emit recommendations but force `continue` at runtime. **Recommended `true` for first install.** |
| `softThreshold` | `0.6` | Token-ratio at which `subagent` becomes a candidate. |
| `flushThreshold` | `0.75` | Token-ratio at which `compact`/`clear` activates. |
| `emergencyThreshold` | `0.85` | Token-ratio for hard `compact`/`clear`. |
| `phronesis.disableHttp` | `false` | Skip Phronesis HTTP ingest entirely (local no-op). Also via `PHRONESIS_DISABLE_HTTP=1`. |
| `phronesis.mode` | `queued` | `queued` (async spool) or `sync` (blocking HTTP). |
| `phronesis.apiBase` | `http://127.0.0.1:8788` | MemoryOwn-compatible Phronesis endpoint. |
| `assei.*` | _see [`@iyen/assei`](../assei) README_ | Forwarded straight to the assei loop. |

### Strategy decision (simplified)

```
hardCritical?
├─ promptTooLong → compact
├─ stuckRunSignal → rewind
├─ tool output bomb → clear
└─ else → compact

token usage ≥ emergency (0.85)?
├─ tool output big → clear
└─ else → compact

heavy exploration + subagent candidate? → subagent

token usage ≥ flush (0.75)?
├─ tool output big → clear
└─ else → compact

branch unstable + solid node available? → rewind
token usage ≥ soft (0.6) + subagent candidate? → subagent
else → continue
```

---

## Lifecycle hooks

| Hook | Role |
|---|---|
| `assemble` | Sanitize messages (orphan tool-call/result removal), trim to token budget, append strategy hint to system prompt. |
| `maintain` | Derive health signals → choose strategy. In `observeOnly` mode, force strategy to `continue` while keeping `recommendedStrategy` for telemetry. |
| `afterTurn` | Run Assei loop (optional), then if strategy is `compact`/`rewind`/`subagent`, push turn summary to Phronesis spool. |
| `compact` | Delegate to OpenClaw runtime (no custom compaction in v0.1.0). |

---

## Tests

```bash
pnpm --filter @iyen/session-branch-engine test
```

Additional offline scenarios:

```bash
node packages/session-branch-engine/test-afterturn-strategy.mjs
node packages/session-branch-engine/test-message-shape.mjs
node packages/session-branch-engine/test-observe-only.mjs
node packages/session-branch-engine/test-sanitize-tool-pairs.mjs
```

`test-afterturn-spool.mjs` requires a live Phronesis service on
`127.0.0.1:8788`; it is not run as part of the default test script.

---

## Phronesis quick check

If the user runs a Phronesis service and you want to verify the ingest
path lands a turn summary:

```bash
node --input-type=module -e '
import { createHttpPhronesisMediation } from "./packages/session-branch-engine/phronesis-http-mediation.mjs";
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

## Roadmap

1. Real `clear` / `rewind` side-effect implementation (currently decision-only).
2. Custom compaction (currently delegated to runtime).
3. Phronesis flush-worker auto-merge of approved candidates.
4. Reviewer policy beyond the minimal placeholder.

## License

MIT
