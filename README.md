# openclaw-extensions

IYENTeam's [OpenClaw](https://github.com/openclaw/openclaw) plugin extensions.
Each package is a self-contained OpenClaw plugin that registers via the
standard plugin interface.

> **Status:** prototypes. APIs may shift with upstream OpenClaw releases.

---

## For agents installing on behalf of a user

> If you are an OpenClaw / Codex / Claude Code agent reading this, follow the
> rules below to pick and install the right package without ambiguity.

### Step 1 — pick by user intent

| If the user says... | Install | Reason |
|---|---|---|
| "keep working / continue automatically / run until done / autonomous loop" | **`@iyen/assei`** | Verifier loop that decides DONE/CONTINUE and re-spawns the same session. |
| "use a different / cheaper / external model **only** for the keep-going decision" | **`@iyen/assei`** with `assei.model` set | Pin a verifier model independent of the main agent model. |
| "decide when to compact / rewind / clear context / split into subagents" | **`@iyen/session-branch-engine`** | Five strategy decisions per turn (continue/compact/clear/rewind/subagent). |
| "ingest turn summaries into long-term memory (Phronesis)" | **`@iyen/session-branch-engine`** | Drives the Phronesis spool. |
| "both autonomous loop AND smart context strategy" | **`@iyen/session-branch-engine`** only | It already calls assei internally via `config.assei`. **Do not register both as `contextEngine` slot — only one wins.** |

If the user is not specific, ask one clarifying question before installing
**either**:
> "Do you want auto-continuation after every turn (assei) or smarter
> context management — compact/rewind/clear (session-branch-engine)?"

### Step 2 — install (run from anywhere)

```bash
# 1. Clone or pull this repo somewhere stable on the user's machine
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only

# 2. Link the package the user picked into OpenClaw (pick ONE)
openclaw plugins install --link "$REPO/packages/assei"
# OR
openclaw plugins install --link "$REPO/packages/session-branch-engine"
```

### Step 3 — bind to the contextEngine slot

OpenClaw needs to know which plugin to use as its context engine. Patch
`~/.openclaw/openclaw.json` to set the slot, the allow-list, and any
package-specific settings. Use exactly one of the snippets below.

**For `@iyen/assei`:**

```jsonc
{
  "plugins": {
    "slots": { "contextEngine": "assei" },
    "allow": ["assei"],
    "entries": {
      "assei": {
        "enabled": true,
        "config": {
          // REQUIRED — Assei is an EXTERNAL verifier and must be pinned to
          // a model that is independent of the main agent. Replace with an
          // actual model id the user has access to (e.g.
          // "openai/gpt-5-mini", "anthropic/claude-haiku-4",
          // "apiclient/glm-5.1"). If you (the agent) don't know which
          // model to use, ASK first.
          "model": "<provider>/<verifier-model-id>"
        }
      }
    }
  }
}
```

**For `@iyen/session-branch-engine`:**

```jsonc
{
  "plugins": {
    "slots": { "contextEngine": "session-branch-engine" },
    "allow": ["session-branch-engine"],
    "entries": {
      "session-branch-engine": {
        "enabled": true,
        "config": {
          "observeOnly": true,
          "softThreshold": 0.6,
          "flushThreshold": 0.75,
          "emergencyThreshold": 0.85,
          "assei": {
            "enabled": true,
            // REQUIRED if assei.enabled. Pin an external verifier model
            // that is independent of the main agent (cheap/fast model
            // preferred). Replace with an actual model id the user has —
            // e.g. "openai/gpt-5-mini", "apiclient/glm-5.1".
            "model": "<provider>/<verifier-model-id>"
          }
        }
      }
    }
  }
}
```

> Merge these into the existing `plugins` block — do not replace the whole
> `~/.openclaw/openclaw.json`.

### Step 4 — verify install

```bash
openclaw plugins list | grep -E '(assei|session-branch-engine)'
# Expected: a row with Status=loaded for the package you installed.

openclaw plugins doctor
# Expected: "No plugin issues detected."
```

If both pass, the plugin is registered. The user must restart the gateway
(`openclaw gateway restart` if running as a service, or simply re-run their
agent) for the new context engine to take effect.

### Hard rules for agents

- **Never** install `assei` (directly or via session-branch-engine) without an explicit `assei.model` set to a model **different from** the main agent. Assei is an external verifier; using the same model defeats it. If the user has not chosen a verifier model, **ask** first — do not pick one silently.
- **Never** put both `assei` and `session-branch-engine` in `plugins.slots.contextEngine` — only one slot value is honored. Pick one.
- **Never** add both to `plugins.allow` unless you also disable assei's redundant top-level binding (session-branch-engine drives assei itself).
- **Never** modify any other key in `~/.openclaw/openclaw.json` (channels, agents, gateway.auth, etc.). The user owns those.
- **Always** make a copy of the original `openclaw.json` before patching:
  ```bash
  cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s)
  ```

---

## Packages

| Package | Plugin id | Slot | One-line description |
|---|---|---|---|
| [`@iyen/assei`](./packages/assei) | `assei` | `contextEngine` | After every turn, ask a verifier model "is more work needed?" — if yes, auto-continue the same session. |
| [`@iyen/session-branch-engine`](./packages/session-branch-engine) | `session-branch-engine` | `contextEngine` | After every turn, decide one of: `continue` / `compact` / `clear` / `rewind` / `subagent`. Optionally drives `@iyen/assei` and ingests turn summaries into Phronesis. |

Each package's own README has the full configuration reference and runtime
requirements. Read them when you need anything beyond the install steps
above.

---

## Repository layout

```
openclaw-extensions/
├── package.json                         # workspace root (pnpm)
├── pnpm-workspace.yaml
└── packages/
    ├── assei/
    │   ├── package.json                  # @iyen/assei
    │   ├── openclaw.plugin.json          # plugin manifest
    │   ├── index.mjs                     # plugin entry (registerContextEngine)
    │   ├── assei-loop.mjs                # verifier loop core
    │   ├── test-assei-loop.mjs           # unit tests
    │   ├── test-plugin.mjs               # plugin integration tests
    │   ├── test-e2e-gateway.sh           # real-gateway E2E
    │   └── README.md
    └── session-branch-engine/
        ├── package.json                  # @iyen/session-branch-engine
        ├── openclaw.plugin.json
        ├── index.mjs
        └── …
```

## Development

```bash
pnpm install
pnpm -r run test                  # all unit tests
pnpm --filter @iyen/assei test:e2e  # real openclaw gateway E2E (mutates ~/.openclaw, restores on exit)
```

## License

MIT — see [LICENSE](./LICENSE).
