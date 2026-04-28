# openclaw-extensions

**An [OpenClaw](https://github.com/openclaw/openclaw) extension repository
by IYENTeam.**

[OpenClaw](https://github.com/openclaw/openclaw) is an extensible
agent runtime: it exposes a plugin contract (`registerContextEngine`,
`afterTurn`, `assemble`, `compact`, `PluginRuntime.subagent.*`, …) and
loads packages whose `package.json` declares an `openclaw.extensions`
entry. This repository is a workspace of such extensions.

It currently ships a single extension — **`@iyen/assei`** — an
**external-verifier context engine**: after every agent turn it asks an
*independent* model "is more work needed?" and, if yes, auto-continues
the same OpenClaw session until that verifier says DONE or BLOCKED.

> **Status:** prototype. The plugin contract follows OpenClaw's published
> extension API; APIs may shift with upstream OpenClaw releases.

---

## What this extension plugs into (OpenClaw vocabulary)

| OpenClaw concept | How `@iyen/assei` uses it |
|---|---|
| Plugin manifest (`openclaw.plugin.json`) | declares plugin id `assei` and `configSchema` (model required) |
| Plugin entry (`package.json` → `openclaw.extensions`) | exports `register(api)` from `index.mjs` |
| Plugin slot (`plugins.slots.contextEngine`) | binds `assei` as the active context engine |
| Allow-list (`plugins.allow`) | must include `"assei"` for the runtime to load it |
| Hook: `afterTurn(params)` | runs the verifier and decides CONTINUE / DONE / BLOCKED |
| Runtime: `PluginRuntime.subagent.*` | invokes the verifier model — OpenClaw owns provider/auth/billing |
| Runtime: `openclaw agent --session-id` | spawned (detached) for the auto-continuation when verdict is CONTINUE |

If you are not yet familiar with OpenClaw's plugin model, read the
upstream extension docs first; the rest of this README assumes it.

---

## For agents installing on behalf of a user

> If you are an OpenClaw / Codex / Claude Code agent reading this, follow
> the rules below to install Assei into the user's OpenClaw without
> ambiguity. **Assei is the only extension in this repo** — there is no
> "pick one"; just install it if the user wants the autonomous-continuation
> loop on top of OpenClaw.

### Step 1 — confirm intent

Install `@iyen/assei` if (and only if) the user wants any of the
following layered on top of their OpenClaw runtime:

- "keep working / continue automatically / run until done / autonomous loop"
- "use a different / cheaper / external model **only** for the keep-going decision"
- "verify each turn against a second model before stopping"

If the user wants **smart context strategy** (compact / rewind / clear /
spawn subagent), this repo does **not** provide an OpenClaw extension for
that anymore. Tell the user and stop — do not install Assei as a substitute.

### Step 2 — pick a verifier model **before** installing

Assei is by definition an *external* verifier. It must be pinned to a
model that is **independent of the main OpenClaw agent**. If the user
has not already chosen one, **ask**:

> "Assei needs an external verifier model — independent of your main
> OpenClaw agent — to decide CONTINUE/DONE/BLOCKED each turn. Pick a
> cheap/fast model OpenClaw can already invoke, e.g. `openai/gpt-5-mini`,
> `anthropic/claude-haiku-4`, `apiclient/glm-5.1`. Which one should I use?"

Do **not** silently default to whatever the main agent uses. The plugin
will refuse to run without `assei.model` set, and a `validator_failed`
entry will appear in the audit log every turn until you fix it.

### Step 3 — install the extension into OpenClaw

```bash
# 1. Clone or pull this extension repo somewhere stable on the user's machine
REPO=$HOME/.openclaw/extensions/openclaw-extensions
git clone https://github.com/IYENTeam/openclaw-extensions.git "$REPO" 2>/dev/null \
  || git -C "$REPO" pull --ff-only

# 2. Register the extension with OpenClaw (link mode)
openclaw plugins install --link "$REPO/packages/assei"
```

`openclaw plugins install --link` reads `packages/assei/package.json`,
discovers the `openclaw.extensions` entry, and wires the plugin into the
OpenClaw plugin loader without copying files.

### Step 4 — bind the extension to the contextEngine slot

OpenClaw needs to know which extension to use as its context engine.
Patch `~/.openclaw/openclaw.json` to set the slot, the allow-list, and
the required verifier model. Make a backup first:

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
          // to a model that is independent of the main OpenClaw agent.
          // Replace with the model id the user picked in Step 2.
          "model": "<provider>/<verifier-model-id>"
        }
      }
    }
  }
}
```

### Step 5 — verify the extension loaded

```bash
openclaw plugins list | grep assei
# Expected: a row with Status=loaded.

openclaw plugins doctor
# Expected: "No plugin issues detected."
```

If both pass, the extension is registered with OpenClaw. The user must
restart the gateway (`openclaw gateway restart` if running as a service,
or simply re-run their agent) for the new context-engine slot binding to
take effect.

### Hard rules for agents

- **Never** install Assei without an explicit `assei.model` set to a model
  **different from** the main OpenClaw agent. The plugin refuses to run
  otherwise and writes `validator_failed: assei.model is required` to the
  audit log every turn. If the user has not chosen a verifier model, **ask
  first** — do not pick one silently.
- **Never** modify any other key in `~/.openclaw/openclaw.json` (channels,
  agents, gateway.auth, etc.). The user owns those.
- **Never** install Assei when the user only runs `openclaw agent --local`.
  Assei requires a real OpenClaw gateway runtime; `--local` does not
  expose `PluginRuntime.subagent`, so the verifier silently no-ops.
- **Always** back up `~/.openclaw/openclaw.json` before patching it.

---

## Extensions in this repo

| Extension | Plugin id | OpenClaw slot | One-line description |
|---|---|---|---|
| [`@iyen/assei`](./packages/assei) | `assei` | `contextEngine` | After every OpenClaw turn, ask an independent verifier model "is more work needed?" — if yes, auto-continue the same session via `openclaw agent --session-id`. |

See [`packages/assei/README.md`](./packages/assei/README.md) for the
full configuration reference, OpenClaw runtime requirements, audit-log
format, and programmatic API.

---

## Repository layout

```
openclaw-extensions/
├── package.json                         # workspace root (pnpm)
├── pnpm-workspace.yaml
└── packages/
    └── assei/                            # OpenClaw extension package
        ├── package.json                  # @iyen/assei (declares openclaw.extensions)
        ├── openclaw.plugin.json          # OpenClaw plugin manifest (id, configSchema)
        ├── index.mjs                     # plugin entry — register(api) → registerContextEngine
        ├── assei-loop.mjs                # verifier loop core (uses runtime.subagent)
        ├── test-assei-loop.mjs           # unit tests (mocked subagent)
        ├── test-plugin.mjs               # plugin integration tests against a fake api
        ├── test-e2e-gateway.sh           # real-OpenClaw-gateway E2E
        └── README.md
```

## Development

```bash
pnpm install
pnpm -r run test                                       # unit tests (mocked subagent)
ASSEI_E2E_MODEL=apiclient/glm-5.1 \
  pnpm --filter @iyen/assei test:e2e                   # real OpenClaw gateway E2E
                                                       # (mutates ~/.openclaw, restores on exit)
```

## License

MIT — see [LICENSE](./LICENSE).
