# @iyen/external-verifier

External validation loop for [OpenClaw](https://github.com/openclaw/openclaw)
continuous mode.

After each agent turn, spawns an independent verifier model (default
`closedrouter-zai/glm-5.1`) to decide whether the session should
**CONTINUE**, is **DONE**, or is **BLOCKED**.

If the verdict is CONTINUE and the per-session continue cap hasn't been
reached, a detached `openclaw agent --session-id … --message …` process is
spawned to resume the session.

## Usage (standalone)

```js
import { maybeRunExternalValidationLoop } from "@iyen/external-verifier";

const result = await maybeRunExternalValidationLoop(
  { sessionId: "ses_abc", messages: [...] },
  { externalValidation: { enabled: true, model: "closedrouter-zai/glm-5.1" } },
);
// result.action: 'disabled' | 'skip' | 'validated_stop' | 'spawn_continue' | 'blocked' | 'error'
```

## Usage (from session-branch-engine)

`@iyen/session-branch-engine` imports this package as a workspace dependency
and calls `maybeRunExternalValidationLoop` in its `afterTurn` hook.

## Configuration

Environment variables or `config.externalValidation.*`:

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable/disable the loop |
| `model` | `closedrouter-zai/glm-5.1` | Verifier model |
| `timeoutMs` | `120000` | Verifier call timeout |
| `agentTimeoutSeconds` | `600` | Spawned continuation timeout |
| `maxContinuesPerSession` | `8` | Cap before forced BLOCKED |
| `dryRun` | `false` | Log without spawning |

## License

MIT
