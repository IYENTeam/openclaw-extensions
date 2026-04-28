#!/usr/bin/env bash
# Real E2E test for @iyen/assei against an actual openclaw gateway.
#
# What it does (in order):
#   1. Sanity-checks the local openclaw install + config.
#   2. Backs up ~/.openclaw/openclaw.json so the test never leaves the user's
#      machine in a different state than it found it.
#   3. Links the local @iyen/assei package as an openclaw plugin and binds it
#      to the contextEngine slot.
#   4. Starts an openclaw gateway daemon in foreground on the configured port
#      with auth=none + bind=loopback (loopback only, never exposed off-host).
#   5. Drives a single agent turn through the gateway (NOT --local) so the
#      plugin's afterTurn fires inside an actual gateway request scope and
#      runtime.subagent is real.
#   6. Asserts that assei wrote sensible state/log artifacts.
#   7. Cleans up unconditionally: kills gateway, removes verifier sessions,
#      restores the original openclaw.json.
#
# Usage:
#   ./test-e2e-gateway.sh
#
# Optional env vars:
#   OPENCLAW_BIN     - path to openclaw CLI (default: ~/.openclaw/bin/openclaw)
#   ASSEI_E2E_PORT   - gateway port (default: 18789)
#   ASSEI_E2E_KEEP   - if "1", do NOT restore config / kill gateway on exit
#                       (debug-only; you must clean up manually)

set -uo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_BIN="${OPENCLAW_BIN:-$HOME/.openclaw/bin/openclaw}"
PORT="${ASSEI_E2E_PORT:-18789}"
CONFIG_PATH="$HOME/.openclaw/openclaw.json"
WORKSPACE="$HOME/.openclaw/workspace"
ASSEI_STATE="$WORKSPACE/.openclaw/assei.json"
ASSEI_LOG="$WORKSPACE/.openclaw/assei.log"
SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"

TMP_DIR="$(mktemp -d -t assei-e2e-XXXXXX)"
CONFIG_BACKUP="$TMP_DIR/openclaw.json.backup"
GW_LOG="$TMP_DIR/gateway.log"
AGENT_OUT="$TMP_DIR/agent.json"

PASS=0
FAIL=0

step()    { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()      { printf "  \033[32m✔\033[0m %s\n" "$*"; PASS=$((PASS+1)); }
fail()    { printf "  \033[31m✘\033[0m %s\n" "$*"; FAIL=$((FAIL+1)); }
note()    { printf "  · %s\n" "$*"; }

# ---------------------------------------------------------------------------
# Cleanup (always runs)
# ---------------------------------------------------------------------------
GATEWAY_PID=""
INSTALLED_PLUGIN=0

cleanup() {
  local rc=$?
  if [ "${ASSEI_E2E_KEEP:-0}" = "1" ]; then
    note "ASSEI_E2E_KEEP=1 — leaving environment as-is for inspection"
    note "  gateway log: $GW_LOG"
    note "  config backup: $CONFIG_BACKUP"
    return $rc
  fi

  step "cleanup"

  # 1) Kill the gateway we started, if any
  if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
      kill -9 "$GATEWAY_PID" 2>/dev/null || true
    fi
    note "gateway stopped (pid=$GATEWAY_PID)"
  fi

  # 2) Restore original openclaw.json (covers: config patch, plugin install,
  #    auto-generated tokens, etc.)
  if [ -f "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$CONFIG_PATH"
    note "config restored from backup"
  fi

  # 3) Purge verifier session entries + jsonl files that assei created
  python3 - <<'PY' 2>/dev/null || true
import json, os, sys
sj = os.path.expanduser('~/.openclaw/agents/main/sessions/sessions.json')
if not os.path.exists(sj):
    sys.exit(0)
data = json.load(open(sj))
to_remove = [k for k in list(data.keys()) if 'assei-verifier' in k]
ids = [data[k].get('sessionId') for k in to_remove if data[k].get('sessionId')]
for k in to_remove:
    data.pop(k, None)
open(sj, 'w').write(json.dumps(data, indent=2))
sdir = os.path.dirname(sj)
removed = 0
for sid in ids:
    for ext in ('.jsonl', '.jsonl.lock'):
        f = os.path.join(sdir, sid + ext)
        if os.path.exists(f):
            os.unlink(f); removed += 1
print(f"purged {len(to_remove)} verifier sessionKeys, {removed} session files")
PY

  # 4) Wipe assei artifacts in the user's workspace
  rm -f "$ASSEI_STATE" "$ASSEI_LOG"
  note "assei artifacts in workspace removed"

  # 5) Tmp dir
  rm -rf "$TMP_DIR"

  # Final summary
  printf "\n"
  if [ "$FAIL" -eq 0 ]; then
    printf "\033[1;32mE2E summary: %d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
  else
    printf "\033[1;31mE2E summary: %d passed, %d failed\033[0m\n" "$PASS" "$FAIL"
    rc=1
  fi

  exit $rc
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
step "preflight"

if [ ! -x "$OPENCLAW_BIN" ]; then
  fail "openclaw binary not found at $OPENCLAW_BIN"
  exit 1
fi
ok "openclaw binary: $OPENCLAW_BIN"

if [ ! -f "$CONFIG_PATH" ]; then
  fail "openclaw config not found at $CONFIG_PATH"
  exit 1
fi
ok "openclaw config: $CONFIG_PATH"

# Make sure no other process is already on the port
if lsof -nPiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use; stop the listener or set ASSEI_E2E_PORT"
  exit 1
fi
ok "port $PORT is free"

# ---------------------------------------------------------------------------
# Backup config + clear pre-existing assei artifacts
# ---------------------------------------------------------------------------
cp "$CONFIG_PATH" "$CONFIG_BACKUP"
ok "config backup → $CONFIG_BACKUP"
rm -f "$ASSEI_STATE" "$ASSEI_LOG"

# ---------------------------------------------------------------------------
# Install assei plugin (linked) + bind to contextEngine slot
# ---------------------------------------------------------------------------
step "install assei plugin (linked)"

"$OPENCLAW_BIN" plugins install --link "$PKG_DIR" >/dev/null 2>&1
INSTALLED_PLUGIN=1
ok "linked: $PKG_DIR"

python3 - "$CONFIG_PATH" "$PORT" <<'PY'
import json, sys
p, port = sys.argv[1], int(sys.argv[2])
c = json.load(open(p))
plugins = c.setdefault('plugins', {})
plugins.setdefault('slots', {})['contextEngine'] = 'assei'
allow = plugins.setdefault('allow', [])
if 'assei' not in allow: allow.append('assei')
gw = c.setdefault('gateway', {})
gw['mode'] = 'local'
gw.setdefault('bind', 'loopback')
gw['port'] = port
gw.pop('auth', None)
open(p, 'w').write(json.dumps(c, indent=2))
PY
ok "config patched: contextEngine=assei, gateway.mode=local, port=$PORT"

# ---------------------------------------------------------------------------
# Start gateway (background)
# ---------------------------------------------------------------------------
step "start gateway"

"$OPENCLAW_BIN" gateway run --auth none --bind loopback --verbose \
  > "$GW_LOG" 2>&1 &
GATEWAY_PID=$!
note "gateway pid=$GATEWAY_PID, log=$GW_LOG"

# Wait for gateway readiness via health RPC (up to ~30s)
ready=0
for i in $(seq 1 30); do
  if "$OPENCLAW_BIN" gateway call health --json --timeout 2000 >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  fail "gateway did not become ready in 30s"
  note "tail $GW_LOG:"
  tail -20 "$GW_LOG" | sed 's/^/    /'
  exit 1
fi
ok "gateway responding on port $PORT"

# Confirm assei is loaded as a plugin
if "$OPENCLAW_BIN" plugins list 2>/dev/null | grep -q "assei.*loaded"; then
  ok "assei plugin reported as loaded"
else
  fail "assei plugin not in 'loaded' state"
  "$OPENCLAW_BIN" plugins list 2>&1 | grep -i assei | sed 's/^/    /' || true
fi

# ---------------------------------------------------------------------------
# Drive a single agent turn through the gateway (no --local)
# ---------------------------------------------------------------------------
step "send agent turn through gateway"

# We don't care if the model itself succeeds — we only care that:
#   - afterTurn fires
#   - assei runs and writes its log/state
#   - subagent.run is dispatched without 'request scope' errors
#   - the verifier session exists on disk
#
# So we use a short timeout and ignore the agent's exit code.
"$OPENCLAW_BIN" agent --agent main --thinking off \
  --message "E2E ping: respond STATUS DONE only" \
  --json --timeout 30 > "$AGENT_OUT" 2>&1 || true

ok "agent CLI call returned"
note "agent stdout head:"
head -3 "$AGENT_OUT" | sed 's/^/    /'

# Give the gateway/plugin a moment to flush its post-turn writes
sleep 2

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
step "verify"

# 1. assei.json must exist and contain at least one session entry
if [ -f "$ASSEI_STATE" ]; then
  ok "$ASSEI_STATE exists"
else
  fail "$ASSEI_STATE does not exist (assei never ran)"
fi

session_count="$(python3 - <<'PY'
import json, os
p = os.path.expanduser('~/.openclaw/workspace/.openclaw/assei.json')
try:
  print(len(json.load(open(p)).get('sessions', {})))
except Exception:
  print(0)
PY
)"
if [ "$session_count" -ge 1 ]; then
  ok "assei.json has $session_count session entry"
else
  fail "assei.json has no session entries"
fi

# 2. assei.log must contain at least one action record
if [ -f "$ASSEI_LOG" ]; then
  ok "$ASSEI_LOG exists"
  note "log preview:"
  head -10 "$ASSEI_LOG" | sed 's/^/    /'
else
  fail "$ASSEI_LOG does not exist"
fi

# 3. log must NOT contain the request-scope error (means subagent runtime missing)
if [ -f "$ASSEI_LOG" ] && grep -q "only available during a gateway request" "$ASSEI_LOG"; then
  fail "log contains 'request scope' error — gateway runtime not active"
else
  ok "no 'request scope' error in log (gateway runtime active)"
fi

# 4. log must NOT contain idempotencyKey validation error
if [ -f "$ASSEI_LOG" ] && grep -q "must have required property 'idempotencyKey'" "$ASSEI_LOG"; then
  fail "log contains idempotencyKey validation error"
else
  ok "no idempotencyKey validation error"
fi

# 5. log MUST contain one of the recognized terminal actions
if [ -f "$ASSEI_LOG" ] && grep -qE '"action":"(validated_stop|spawn_continue|blocked|validator_failed)"' "$ASSEI_LOG"; then
  action=$(grep -oE '"action":"[^"]+"' "$ASSEI_LOG" | head -1)
  ok "log records terminal action: $action"
else
  fail "log has no terminal action record (validated_stop/spawn_continue/blocked/validator_failed)"
fi

# 6. self-recursion guard: no more than ~3 sessions should appear in assei.json
#    (1 main session is normal; >5 means cascade is happening)
if [ "$session_count" -le 3 ]; then
  ok "self-recursion guard holding ($session_count session(s); ≤3 expected)"
else
  fail "session cascade detected ($session_count session entries)"
fi

# 7. verifier subagent was actually dispatched.
#    Disk evidence is brittle (deleteSession cleans up the verifier session
#    on success); the authoritative signal is gateway log + assei.log having
#    a recognized terminal action.
if grep -q "assei-verifier" "$GW_LOG"; then
  ok "gateway log shows assei-verifier session activity (subagent.run dispatched)"
else
  fail "gateway log has no assei-verifier session activity"
fi

# Final result is set inside cleanup based on FAIL count.
