# @iyen/assei

OpenClaw context-engine plugin. After every agent turn, asks an external
verifier model "is more work needed?" — if yes, auto-spawns a detached
continuation of the same session so the agent keeps going without further
user input.

- Plugin id: **`assei`**
- Slot: **`contextEngine`**
- Verdict source: any model OpenClaw is already wired up to use (delegates via `runtime.subagent.run`). No HTTP, no separate API key.
- Side effects per turn: writes `<workspace>/.openclaw/assei.json` (dedup state) and `<workspace>/.openclaw/assei.log` (audit trail).

---

## Install (for agents)

> Read the **root [README](../../README.md)** first if you have not picked
> a package yet. Below is the install recipe assuming the user wants
> autonomous continuation specifically.

### 1. Link the plugin

```bash
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only
openclaw plugins install --link "$REPO/packages/assei"
```

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
        "enabled": true
        // Optional: pin a verifier-only model (else openclaw default agent
        // model is used).
        // "model": "openai/gpt-5-mini"
      }
    }
  }
}
```

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

- Do **not** also bind `session-branch-engine` to `plugins.slots.contextEngine` — only one wins. If the user wants both behaviors, install **`session-branch-engine` instead** and enable `assei` inside its `entries.session-branch-engine.assei` block.
- Do **not** edit any other key in `~/.openclaw/openclaw.json` (channels, agents, gateway.auth, etc.).
- Do **not** add this plugin if the user only wants `--local` embedded runs — assei requires a real gateway runtime to function (see "Runtime requirement" below).

---

## Configuration reference

`plugins.entries.assei.*`:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable the loop. |
| `model` | _openclaw default_ | Verifier model id passed to `subagent.run({ model })`. Pin a small/fast model just for verification. |
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

## Runtime requirement

`PluginRuntime.subagent.*` is only exposed when the plugin runs inside an
actual gateway request lifecycle:

- ✅ Works behind `openclaw gateway` (channels, `openclaw agent` without `--local`).
- ❌ Disabled inside `openclaw agent --local` (embedded runner does not expose subagent). Assei detects this and silently no-ops the verifier instead of crashing the turn.

---

## How it works

```
OpenClaw afterTurn
   │
   ▼
assei plugin
   │  build params { sessionId, messages, turnId, runtimeContext }
   ▼
maybeRunAssei()
   │  open ephemeral verifier session via runtime.subagent.run({
   │    sessionKey: "assei-verifier:<parent>:<turn>",
   │    idempotencyKey: "assei:<parent>:<turn>",
   │    message: <verifier prompt>,
   │    model: <optional override>,
   │  })
   │  → subagent.waitForRun
   │  → subagent.getSessionMessages → parse "STATUS: CONTINUE|DONE|BLOCKED"
   │  → subagent.deleteSession (cleanup)
   │
   ├─ DONE/BLOCKED ──→ record verdict, stop
   │
   └─ CONTINUE ──→ spawn detached `openclaw agent --session-id <same>`
                    (autonomous next turn)
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

The E2E script (`test-e2e-gateway.sh`):

- requires a local openclaw at `~/.openclaw/bin/openclaw` (override `OPENCLAW_BIN`)
- needs a populated `~/.openclaw/openclaw.json` (auto-backed-up + restored)
- needs port `18789` free (override `ASSEI_E2E_PORT`)
- runs 17 assertions over disk artifacts and gateway log evidence
- `ASSEI_E2E_KEEP=1` leaves env up for inspection (you must clean up)

---

## Programmatic use (advanced)

`maybeRunAssei` accepts an injected `deps.subagent` so other context
engines can drive Assei without going through this plugin shell:

```js
import { maybeRunAssei } from "@iyen/assei";

const result = await maybeRunAssei(
  { sessionId: "ses_abc", messages: [...] },
  { assei: { enabled: true } },
  { subagent: api.runtime.subagent }, // captured at register(api) time
);
// result.action:
//   'disabled' | 'skip' | 'validated_stop' | 'spawn_continue' | 'blocked' | 'error'
```

`@iyen/session-branch-engine` uses exactly this pattern.

For backward compatibility, `config.externalValidation.*` and
`config.continuousExternalValidation.*` are still accepted as fallback
input shapes when reading config.

## License

MIT
