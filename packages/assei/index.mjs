import { maybeRunAssei } from "./assei-loop.mjs";

/**
 * @iyen/assei — OpenClaw context-engine plugin that asks an external verifier
 * after every turn whether work remains, and if so, spawns a detached
 * `openclaw agent --session-id <same>` to continue the session.
 *
 * This file is the OpenClaw plugin entry. The verifier core lives in
 * ./assei-loop.mjs and is also exported from the package main so other code
 * can call `maybeRunAssei` directly without the plugin shell.
 *
 * The plugin does NOT participate in assemble/compact/maintenance: those hooks
 * are no-op pass-throughs so it can coexist with any other context-engine that
 * the user actually wants for context strategy (e.g. @iyen/session-branch-engine).
 */

function buildAsseiParams(params) {
  // OpenClaw's afterTurn signature provides:
  //   { sessionId, sessionKey?, sessionFile, messages, prePromptMessageCount,
  //     autoCompactionSummary?, isHeartbeat?, tokenBudget?, runtimeContext? }
  //
  // Assei's maybeRunAssei expects:
  //   { sessionId | sessionKey, messages, turnId?, runId?, runtimeContext? }
  //
  // We pass through everything Assei understands. turnId is derived from
  // prePromptMessageCount + final-message identity so that the same turn
  // doesn't re-trigger Assei when openclaw replays afterTurn.
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  const lastMessage = messages[messages.length - 1] ?? null;
  const lastId = lastMessage?.id ?? lastMessage?.turnId ?? null;
  const turnId = lastId
    ? String(lastId)
    : `pp-${params?.prePromptMessageCount ?? 0}-len-${messages.length}`;

  return {
    sessionId: params?.sessionId,
    sessionKey: params?.sessionKey,
    messages,
    turnId,
    runtimeContext: params?.runtimeContext,
  };
}

export default function register(api) {
  // Capture the trusted plugin runtime at registration time. The verifier
  // delegates model invocation to `runtime.subagent.*`, so openclaw owns
  // provider/auth/model selection — assei never speaks HTTP itself.
  const subagent = api?.runtime?.subagent;
  const logger = api?.logger;

  api.registerContextEngine("assei", (config = {}) => ({
    info: {
      id: "assei",
      name: "Assei",
      version: "0.1.0",
      ownsCompaction: false,
      turnMaintenanceMode: "foreground",
    },

    // Required hook. Assei doesn't ingest; report a no-op.
    async ingest() {
      return { ingested: false };
    },

    // Required hook. Pass messages through unchanged so this plugin doesn't
    // interfere with whatever context strategy the user prefers.
    async assemble({ messages = [] }) {
      const safeMessages = Array.isArray(messages) ? messages : [];
      return {
        messages: safeMessages,
        estimatedTokens: 0,
      };
    },

    // Required hook. We never own compaction.
    async compact() {
      return { ok: true, compacted: false, reason: "assei is a sidecar engine; compaction is delegated" };
    },

    // The point of this plugin.
    async afterTurn(params) {
      if (params?.isHeartbeat) return; // never inject continuation on heartbeats
      if (!subagent) {
        // Plugin runtime did not expose subagent — without it the verifier
        // cannot run. Log once and silently no-op rather than crash openclaw.
        try { logger?.warn?.("[assei] PluginRuntime.subagent not available; verifier disabled for this turn"); } catch {}
        return;
      }
      const asseiParams = buildAsseiParams(params);
      // The plugin's `config` IS the assei settings block from openclaw.json
      // (entries.assei.*). maybeRunAssei expects either { assei: {...} } or
      // a legacy externalValidation wrapper; wrap so both call paths
      // (standalone plugin vs embedded inside session-branch-engine) work.
      const wrappedConfig = (config && (config.assei || config.externalValidation))
        ? config
        : { assei: config };
      // Inject the captured subagent API; result is logged inside maybeRunAssei.
      await maybeRunAssei(asseiParams, wrappedConfig, { subagent });
    },
  }));
}

// Re-export the core verifier API so callers can use `@iyen/assei` directly
// from any code (not just as an OpenClaw plugin):
//
//   import { maybeRunAssei } from '@iyen/assei';
//
// `buildAsseiParams` is also exposed so callers wiring Assei from a custom
// context engine don't have to reimplement the OpenClaw param shim.
export { maybeRunAssei, normalizeAsseiStatus } from "./assei-loop.mjs";
export { buildAsseiParams };
