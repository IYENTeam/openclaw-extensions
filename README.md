# openclaw-extensions

IYENTeam's [OpenClaw](https://github.com/openclaw/openclaw) plugin extensions.
Currently ships a single plugin: **`@iyen/assei`** — an external-verifier
context engine that auto-continues a session until an independent model
says the work is done.

> **Status:** prototype. APIs may shift with upstream OpenClaw releases.

---

## For agents installing on behalf of a user

> If you are an OpenClaw / Codex / Claude Code agent reading this, follow
> the rules below to install Assei without ambiguity. **Assei is the only
> plugin in this repo** — there is no "pick one"; just install it if the
> user wants the autonomous-continuation loop.

### Step 1 — confirm intent

Install `@iyen/assei` if (and only if) the user wants any of:

- "keep working / continue automatically / run until done / autonomous loop"
- "use a different / cheaper / external model **only** for the keep-going decision"
- "verify each turn against a second model before stopping"

If the user wants **smart context strategy** (compact / rewind / clear /
spawn subagent), this repo does **not** provide it anymore. Tell the user
and stop — do not install Assei as a substitute.

### Step 2 — pick a verifier model **before** installing

Assei is by definition an *external* verifier. It must be pinned to a
model that is **independent of the main agent**. If the user has not
already chosen one, **ask**:

> "Assei needs an external verifier model — independent of your main
> agent — to decide CONTINUE/DONE/BLOCKED each turn. Pick a cheap/fast
> model, e.g. `openai/gpt-5-mini`, `anthropic/claude-haiku-4`,
> `apiclient/glm-5.1`. Which one should I use?"

Do **not** silently default to whatever the main agent uses. The plugin
will refuse to run without `assei.model` set, and a `validator_failed`
entry will appear in the audit log every turn until you fix it.

### Step 3 — install

```bash
# 1. Clone or pull this repo somewhere stable on the user's machine
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only

# 2. Link the plugin into OpenClaw
openclaw plugins install --link "$REPO/packages/assei"
```

### Step 4 — bind to the contextEngine slot

OpenClaw needs to know which plugin to use as its context engine. Patch
`~/.openclaw/openclaw.json` to set the slot, the allow-list, and the
required verifier model. Make a backup first:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s)
```

Merge this block into the existing `plugins` object (do **not** replace
the whole file):

```jsonc
{
  "plugins": {
    "slots": { "contextEngine": "assei" },
    "allow": ["assei"],
    "entries": {
      "assei": {
        "enabled": true,
        "config": {
          // REQUIRED — Assei is an EXTERNAL verifier and must be pinned
          // to a model that is independent of the main agent. Replace
          // with the model id the user picked in Step 2.
          "model": "<provider>/<verifier-model-id>"
        }
      }
    }
  }
}
```

### Step 5 — verify install

```bash
openclaw plugins list | grep assei
# Expected: a row with Status=loaded.

openclaw plugins doctor
# Expected: "No plugin issues detected."
```

If both pass, the plugin is registered. The user must restart the gateway
(`openclaw gateway restart` if running as a service, or simply re-run
their agent) for the new context engine to take effect.

### Hard rules for agents

- **Never** install Assei without an explicit `assei.model` set to a model
  **different from** the main agent. The plugin refuses to run otherwise
  and writes `validator_failed: assei.model is required` to the audit log
  every turn. If the user has not chosen a verifier model, **ask first**
  — do not pick one silently.
- **Never** modify any other key in `~/.openclaw/openclaw.json` (channels,
  agents, gateway.auth, etc.). The user owns those.
- **Never** install Assei when the user only runs `openclaw agent --local`.
  Assei requires a real gateway runtime; `--local` does not expose
  `runtime.subagent`, so the verifier silently no-ops.
- **Always** back up `~/.openclaw/openclaw.json` before patching it.

---

## Packages

| Package | Plugin id | Slot | One-line description |
|---|---|---|---|
| [`@iyen/assei`](./packages/assei) | `assei` | `contextEngine` | After every turn, ask an independent verifier model "is more work needed?" — if yes, auto-continue the same session. |

See [`packages/assei/README.md`](./packages/assei/README.md) for the
full configuration reference, runtime requirements, audit-log format,
and programmatic API.

---

## Repository layout

```
openclaw-extensions/
├── package.json                         # workspace root (pnpm)
├── pnpm-workspace.yaml
└── packages/
    └── assei/
        ├── package.json                  # @iyen/assei
        ├── openclaw.plugin.json          # plugin manifest
        ├── index.mjs                     # plugin entry (registerContextEngine)
        ├── assei-loop.mjs                # verifier loop core
        ├── test-assei-loop.mjs           # unit tests
        ├── test-plugin.mjs               # plugin integration tests
        ├── test-e2e-gateway.sh           # real-gateway E2E
        └── README.md
```

## Development

```bash
pnpm install
pnpm -r run test                                       # unit tests
ASSEI_E2E_MODEL=apiclient/glm-5.1 \
  pnpm --filter @iyen/assei test:e2e                   # real openclaw gateway E2E
                                                       # (mutates ~/.openclaw, restores on exit)
```

## License

MIT — see [LICENSE](./LICENSE).
