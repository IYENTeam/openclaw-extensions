# @iyen/assei

**An [OpenClaw](https://github.com/openclaw/openclaw) extension.** Assei is
a `contextEngine`-slot plugin that hooks into OpenClaw's `afterTurn`
lifecycle: after every agent turn it asks an **independent verifier model**
"is more work needed?" — if yes, it auto-spawns a detached
`openclaw agent --session-id <same>` so the agent keeps going on the same
OpenClaw session without further user input.

> **`assei.model` is required.** Assei is by design an *external* verifier:
> it must be pinned to a model that is independent of whatever model is
> driving the main OpenClaw agent. Without that pin the loop quietly
> devolves into "ask yourself if you're done", which is exactly what
> Assei exists to avoid. The plugin therefore refuses to run when no
> model is configured and writes a clear `validator_failed` entry to the
> audit log instead of guessing a fallback.

- OpenClaw plugin id: **`assei`**
- OpenClaw slot: **`contextEngine`**
- OpenClaw hook used: **`afterTurn`** (no-op in `assemble`/`compact`/`ingest`)
- OpenClaw runtime API used: **`PluginRuntime.subagent.{run, waitForRun, getSessionMessages, deleteSession}`**
- Verifier model: **must be pinned via `assei.model` or `OPENCLAW_ASSEI_MODEL`** — any model id that OpenClaw can already invoke (`openai/gpt-5-mini`, `apiclient/glm-5.1`, etc.). OpenClaw owns provider/auth/billing; this plugin never speaks HTTP.
- Side effects per turn: writes `<workspace>/.openclaw/assei.json` (dedup state) and `<workspace>/.openclaw/assei.log` (audit trail).

---

## Install (for agents)

> The root [README](../../README.md) covers the install flow end-to-end
> (intent check → pick a verifier model → register the extension with
> OpenClaw → patch `~/.openclaw/openclaw.json`). The recipe below is the
> same thing condensed for direct package install.

### 1. Register the extension with OpenClaw

```bash
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only
openclaw plugins install --link "$REPO/packages/assei"
```

`openclaw plugins install --link` reads the package's `package.json` →
`openclaw.extensions` entry and registers `index.mjs` as the plugin's
entry module with the OpenClaw plugin loader.

### 2. Patch `~/.openclaw/openclaw.json`

Make a backup, then merge this block into the existing `plugins` object —
do **not** replace the whole file:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s)
```

```jsonc
{
  "plugins": {
    "slots": { "contextEngine": "assei" },
    "allow": ["assei"],
    "entries": {
      "assei": {
        "enabled": true,
        // REQUIRED. Pin a verifier model that is independent of the main
        // agent. Any model id openclaw can invoke works — e.g.
        // "openai/gpt-5-mini", "anthropic/claude-haiku-4", "apiclient/glm-5.1".
        // Pick something cheap/fast; the verifier only needs to read a
        // short transcript and reply with one of STATUS: CONTINUE/DONE/BLOCKED.
        "model": "<provider>/<verifier-model-id>"
      }
    }
  }
}
```

> Replace `"<provider>/<verifier-model-id>"` with an actual model the user
> has access to. If you (the agent) are unsure, ask the user which of their
> configured models should act as the verifier. **Do not silently default
> to the main agent's model** — that defeats the entire purpose of Assei.

### 3. Verify

```bash
openclaw plugins list | grep -E '^.*assei.*loaded'
openclaw plugins doctor
```

Both must succeed. Restart the gateway for the slot binding to take effect:

```bash
openclaw gateway restart 2>/dev/null \
  || pkill -f 'openclaw gateway run' \
  || echo "(start the gateway manually next time you need it)"
```

### Don'ts (agent rules)

- Do **not** install Assei without an explicit `assei.model`. The plugin will refuse to run and write `validator_failed: assei.model is required` to the audit log on every turn. If the user has not chosen a verifier model, ask before installing.
- Do **not** set `assei.model` to the same model the main agent is using. The whole point of Assei is independent verification.
- Do **not** edit any other key in `~/.openclaw/openclaw.json` (channels, agents, gateway.auth, etc.).
- Do **not** add this plugin if the user only wants `--local` embedded runs — assei requires a real gateway runtime to function (see "Runtime requirement" below).

---

## Configuration reference

`plugins.entries.assei.*`:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable the loop. |
| `model` | **(required, no default)** | Verifier model id passed to `subagent.run({ model })`. Must be set; the plugin refuses to run otherwise. Pick a small/fast model independent of the main agent. |
| `timeoutMs` | `120000` | Verifier subagent wait timeout (ms). |
| `agentTimeoutSeconds` | `600` | Continuation `openclaw agent` timeout (sec). |
| `maxContinuesPerSession` | `8` | Cap on auto-continuations per parent session before forced BLOCKED. |
| `dryRun` | `false` | Log without actually spawning the continuation. Use for diagnosing without side effects. |
| `keepVerifierSession` | `false` | Skip cleanup of the throwaway verifier session (debugging). |
| `openclawBin` | `openclaw` | `openclaw` binary used for the spawned continuation (or set `OPENCLAW_BIN` env). |
| `stateFile` | `<workspace>/.openclaw/assei.json` | Per-session dedup state. |
| `logFile` | `<workspace>/.openclaw/assei.log` | Append-only audit log. |

Env equivalents: `OPENCLAW_ASSEI`, `OPENCLAW_ASSEI_MODEL`,
`OPENCLAW_ASSEI_TIMEOUT_MS`, `OPENCLAW_ASSEI_AGENT_TIMEOUT`,
`OPENCLAW_ASSEI_MAX_CONTINUES`, `OPENCLAW_ASSEI_DRY_RUN`,
`OPENCLAW_ASSEI_STATE`, `OPENCLAW_ASSEI_LOG`.

---

## OpenClaw runtime requirement

`PluginRuntime.subagent.*` is only exposed by OpenClaw when the plugin
runs inside an actual gateway request lifecycle:

- ✅ Works behind `openclaw gateway` (channels, `openclaw agent` without `--local`).
- ❌ Disabled inside `openclaw agent --local` (the embedded OpenClaw runner does not expose `runtime.subagent`). Assei detects this and silently no-ops the verifier instead of crashing the turn.

This is a property of OpenClaw, not Assei — any OpenClaw extension that
needs `PluginRuntime.subagent` has the same constraint.

---

## How it works (inside OpenClaw)

```
OpenClaw runtime: agent turn finishes
   │
   │  ── OpenClaw fires the afterTurn hook on the bound contextEngine ──▶
   ▼
@iyen/assei plugin (this package)
   │  build params { sessionId, messages, turnId, runtimeContext }
   ▼
maybeRunAssei()
   │  open ephemeral verifier session via PluginRuntime.subagent.run({
   │    sessionKey: "assei-verifier:<parent>:<turn>",
   │    idempotencyKey: "assei:<parent>:<turn>",
   │    message: <verifier prompt>,
   │    model: <required, from assei.model>,
   │  })
   │  → PluginRuntime.subagent.waitForRun
   │  → PluginRuntime.subagent.getSessionMessages → parse "STATUS: CONTINUE|DONE|BLOCKED"
   │  → PluginRuntime.subagent.deleteSession (cleanup)
   │
   ├─ DONE/BLOCKED ──→ record verdict in audit log, stop
   │
   └─ CONTINUE ──→ spawn detached `openclaw agent --session-id <same>`
                    (OpenClaw runs the autonomous next turn)
```

The verifier prompt is the recent assistant/user transcript (last 8
messages, trimmed) plus instructions to reply with exactly one of
`STATUS: CONTINUE | DONE | BLOCKED`.

---

## Tests

```bash
pnpm --filter @iyen/assei test           # unit + integration (mocked subagent)
pnpm --filter @iyen/assei test:e2e       # real openclaw gateway E2E
```

The E2E script (`test-e2e-gateway.sh`) drives a real OpenClaw gateway:

- requires a local OpenClaw CLI at `~/.openclaw/bin/openclaw` (override `OPENCLAW_BIN`)
- needs a populated `~/.openclaw/openclaw.json` (auto-backed-up + restored)
- needs port `18789` free (override `ASSEI_E2E_PORT`)
- **requires `ASSEI_E2E_MODEL`** — Assei refuses to run without a pinned external verifier model
- starts `openclaw gateway run` in the background, exercises a turn through the OpenClaw runtime, and runs 17 assertions over disk artifacts and gateway-log evidence
- `ASSEI_E2E_KEEP=1` leaves env up for inspection (you must clean up)

Example:
```bash
ASSEI_E2E_MODEL=apiclient/glm-5.1 pnpm --filter @iyen/assei test:e2e
```

---

## Programmatic use (advanced — for other OpenClaw extensions)

`maybeRunAssei` accepts an injected `deps.subagent` so another OpenClaw
context-engine extension can drive Assei without going through this
plugin shell:

```js
import { maybeRunAssei } from "@iyen/assei";

// Inside your own OpenClaw extension's register(api):
const result = await maybeRunAssei(
  { sessionId: "ses_abc", messages: [...] },
  { assei: { enabled: true, model: "apiclient/glm-5.1" } },
  { subagent: api.runtime.subagent }, // PluginRuntime.subagent captured at register(api) time
);
// result.action:
//   'disabled' | 'skip' | 'validated_stop' | 'spawn_continue' | 'blocked' | 'error'
```

This is the supported integration point if you are building another
OpenClaw extension that wants the Assei verifier loop as a sub-component
instead of binding `assei` directly to the `contextEngine` slot. Capture
`api.runtime.subagent` at `register(api)` time and pass it as
`deps.subagent`.

For backward compatibility, `config.externalValidation.*` and
`config.continuousExternalValidation.*` are still accepted as fallback
input shapes when reading config.

## License

MIT
