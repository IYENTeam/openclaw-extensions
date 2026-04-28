# openclaw-extensions

IYENTeam's [OpenClaw](https://github.com/openclaw/openclaw) plugin extensions
— context engines, watchdogs, and runtime add-ons that plug into the upstream
OpenClaw runtime via its standard plugin interface.

> **Status:** prototypes / internal use. APIs may shift with upstream OpenClaw
> releases.

## Packages

| Package | Status | Purpose |
|---|---|---|
| [`@iyen/session-branch-engine`](./packages/session-branch-engine) | Prototype, observe-only | OpenClaw context engine for proactive `continue` / `rewind` / `clear` / `compact` / `subagent` branching with Phronesis spool. |
| [`@iyen/external-verifier`](./packages/external-verifier) | Prototype | Independent external validation loop — spawns a verifier model to decide CONTINUE / DONE / BLOCKED after each turn and optionally re-enters the session. |

## Layout

```
openclaw-extensions/
├── package.json            # workspace root
├── pnpm-workspace.yaml
└── packages/
    ├── session-branch-engine/
    │   ├── package.json
    │   ├── openclaw.plugin.json
    │   ├── index.mjs
    │   └── …
    └── external-verifier/
        ├── package.json
        ├── external-validation-loop.mjs
        └── README.md
```

## Development

```bash
pnpm install
pnpm -r run test
```

## Local install into OpenClaw

To register a package directly from the workspace, point your `~/.openclaw/openclaw.json`
plugin install path at the package directory, e.g.:

```jsonc
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/openclaw-extensions/packages/session-branch-engine"
      ]
    },
    "installs": {
      "session-branch-engine": {
        "source": "path",
        "sourcePath": "/path/to/openclaw-extensions/packages/session-branch-engine"
      }
    }
  }
}
```

## License

MIT — see [LICENSE](./LICENSE).
