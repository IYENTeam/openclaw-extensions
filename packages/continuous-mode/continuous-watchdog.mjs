#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = process.env.OPENCLAW_WORKSPACE || '/Users/iyen/.openclaw/workspace'
const statusFile = process.env.CONTINUOUS_STATUS_FILE || join(workspace, '.status-file')
const stateFile = process.env.CONTINUOUS_STATE_FILE || join(here, 'state.json')
const sessionId = process.env.CONTINUOUS_SESSION_ID || ''
const dryRun = process.argv.includes('--dry-run') || process.env.CONTINUOUS_DRY_RUN === '1'
const model = process.env.CONTINUOUS_VALIDATOR_MODEL || 'closedrouter-zai/glm-5.1'

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function normalizeStatus(text) {
  const m = String(text).match(/STATUS:\s*(DONE|BLOCKED|CONTINUE)/i)
  return m ? m[1].toLowerCase() : null
}

function newestDiscordSessionId() {
  const res = sh('openclaw', ['sessions', '--all-agents', '--active', '180', '--json'])
  if (res.code !== 0) return ''
  try {
    const parsed = JSON.parse(res.stdout)
    const list = Array.isArray(parsed) ? parsed : (parsed.sessions || [])
    const hit = list
      .filter((s) => String(s.key || '').startsWith('agent:assistant:discord:channel:'))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]
    return hit?.sessionId || ''
  } catch {
    return ''
  }
}

if (!existsSync(statusFile)) {
  console.log('NO_STATUS_FILE')
  process.exit(0)
}

const stat = statSync(statusFile)
const content = readFileSync(statusFile, 'utf8').trim()
const status = normalizeStatus(content)
const state = readJson(stateFile, {})
const sig = `${stat.mtimeMs}:${content}`

if (!status) {
  console.log('NO_STATUS_TAG')
  process.exit(0)
}
if (state.lastSig === sig) {
  console.log(`UNCHANGED ${status}`)
  process.exit(0)
}

if (status !== 'continue') {
  writeFileSync(stateFile, JSON.stringify({ lastSig: sig, lastStatus: status, updatedAt: new Date().toISOString() }, null, 2))
  console.log(`STOP ${status}`)
  process.exit(0)
}

const validatorPrompt = `You are the external verifier for OpenClaw continuous mode.\n\n.status-file says:\n${content}\n\nDecide whether there is an immediately executable next action remaining. Reply with exactly one line: STATUS: CONTINUE, STATUS: DONE, or STATUS: BLOCKED.`
const verdictRes = sh('openclaw', ['capability', 'model', 'run', '--model', model, '--prompt', validatorPrompt, '--json'], { timeout: 120000 })
if (verdictRes.code !== 0) {
  console.error('VALIDATOR_FAILED')
  console.error(verdictRes.stderr || verdictRes.stdout)
  process.exit(2)
}
let verdictText = verdictRes.stdout
try {
  const parsed = JSON.parse(verdictRes.stdout)
  verdictText = parsed.outputs?.[0]?.text || verdictRes.stdout
} catch {}
const verdict = normalizeStatus(verdictText)

if (verdict !== 'continue') {
  writeFileSync(stateFile, JSON.stringify({ lastSig: sig, lastStatus: status, verdict, updatedAt: new Date().toISOString() }, null, 2))
  console.log(`VALIDATED_STOP ${verdict || 'unknown'}`)
  process.exit(0)
}

const targetSessionId = sessionId || newestDiscordSessionId()
if (!targetSessionId) {
  console.error('NO_SESSION_ID')
  process.exit(3)
}

const message = `[continuous-mode] External validator returned STATUS: CONTINUE for .status-file. Continue the immediately executable next action. Do not repeat prior summary; use tools first if action remains.\n\n${content}`
if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, targetSessionId, verdict, message }, null, 2))
  process.exit(0)
}

writeFileSync(stateFile, JSON.stringify({ lastSig: sig, lastStatus: status, verdict, targetSessionId, updatedAt: new Date().toISOString() }, null, 2))
const run = sh('openclaw', ['agent', '--session-id', targetSessionId, '--message', message, '--timeout', '600'], { timeout: 660000 })
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
process.exit(run.code)
