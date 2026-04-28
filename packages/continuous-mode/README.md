# continuous-mode watchdog sketch

Purpose: bridge `.status-file` output from the finish tool to an actual OpenClaw agent reactivation.

Observed facts:
- `finish` tool writes `.status-file` only.
- Current installed OpenClaw build does not appear to include a consumer that reads `.status-file` and re-enters the session.
- `openclaw agent --session-id <id> --message <text>` can be used as the likely continuation injection path.

Needed behavior:
1. Watch workspace `.status-file` mtime/content.
2. If content starts with `STATUS: CONTINUE`, run external validator.
3. If validator independently says continue, invoke `openclaw agent --session-id <current> --message <continuation prompt>`.
4. If done/blocked, do not re-enter.
5. Avoid loops via run lock and status mtime checkpoint.
