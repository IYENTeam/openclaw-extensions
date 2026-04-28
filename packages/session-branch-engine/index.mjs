import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { deriveSignals } from "./health.mjs";
import { chooseStrategy } from "./strategy.mjs";
import { handleAfterTurnWithPhronesis } from "./phronesis-bridge.ts";
import { shouldIngestToPhronesis } from "./phronesis-policy.mjs";
import { createHttpPhronesisMediation } from "./phronesis-http-mediation.mjs";
import { enqueuePhronesisPayload } from "./phronesis-spool.mjs";
import { applyObserveOnly } from "./observe-only.mjs";
import { maybeRunExternalValidationLoop } from "./external-validation-loop.mjs";

function normalizeContentParts(content) {
  if (Array.isArray(content)) return content;
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (typeof content === 'object' && content !== null) return [content];
  return [];
}

const _TOOL_CALL_TYPES = new Set(['toolCall', 'tool_call', 'tool_use', 'function_call']);
const _TOOL_RESULT_TYPES = new Set(['toolResult', 'tool_result', 'function_call_output']);

function _normalizeCallId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const head = rawId.split('|')[0]?.trim();
  return head || null;
}

function _extractCallIdFromPart(part) {
  if (!part || typeof part !== 'object') return null;
  const id = part.id || part.call_id || part.callId || part.toolUseId
    || part.tool_use_id || part.toolCallId || part.tool_call_id;
  return _normalizeCallId(id);
}

// IYEN "No tool call found" · Anthropic "tool_use_id ... not found" 사고
// 재발 방지용 sanitizer.
//
// 조용히 임무에 사용되는 경로라 보수적으로 동작한다:
//  1. assistant.toolCall(id=X) 가 있으나 다음 turn 안에
//     toolResult(id=X) 가 없는 경우 -> 해당 toolCall part 만 제거
//     (assistant text/thinking part 는 유지).
//  2. toolResult(id=Y) 가 있으나 대응하는 toolCall 이 없는 경우
//     -> 그 toolResult 메시지 전체 drop.
//  3. 원본 messages 배열은 mutation 하지 않는다.
export function sanitizeMessagesForToolPairs(messages = []) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const seenCalls = new Map(); // callId -> { messageIndex }
  const matchedCalls = new Set();
  for (let i = 0; i < safeMessages.length; i++) {
    const m = safeMessages[i];
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const parts = normalizeContentParts(m.content);
    if (role === 'assistant') {
      for (const part of parts) {
        if (_TOOL_CALL_TYPES.has(part?.type)) {
          const id = _extractCallIdFromPart(part);
          if (id) seenCalls.set(id, { messageIndex: i });
        }
      }
    } else if (role === 'toolResult' || role === 'tool' || role === 'tool_result') {
      const directId = _normalizeCallId(
        m.toolCallId || m.tool_call_id || m.toolUseId || m.tool_use_id || m.callId,
      );
      if (directId && seenCalls.has(directId)) matchedCalls.add(directId);
      for (const part of parts) {
        if (_TOOL_RESULT_TYPES.has(part?.type)) {
          const id = _extractCallIdFromPart(part);
          if (id && seenCalls.has(id)) matchedCalls.add(id);
        }
      }
    }
  }
  const orphanCallIds = new Set();
  for (const id of seenCalls.keys()) {
    if (!matchedCalls.has(id)) orphanCallIds.add(id);
  }
  // result 이 매칭 안 되는 toolResult 메시지 인덱스 모음
  const orphanResultIndices = new Set();
  for (let i = 0; i < safeMessages.length; i++) {
    const m = safeMessages[i];
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role !== 'toolResult' && role !== 'tool' && role !== 'tool_result') continue;
    const parts = normalizeContentParts(m.content);
    const directId = _normalizeCallId(
      m.toolCallId || m.tool_call_id || m.toolUseId || m.tool_use_id || m.callId,
    );
    let hasMatched = directId ? seenCalls.has(directId) : false;
    if (!hasMatched) {
      for (const part of parts) {
        if (_TOOL_RESULT_TYPES.has(part?.type)) {
          const id = _extractCallIdFromPart(part);
          if (id && seenCalls.has(id)) {
            hasMatched = true;
            break;
          }
        }
      }
    }
    if (!hasMatched) orphanResultIndices.add(i);
  }

  if (orphanCallIds.size === 0 && orphanResultIndices.size === 0) {
    return {
      messages: safeMessages,
      sanitized: false,
      removedCallIds: [],
      removedResultMessages: 0,
    };
  }

  const out = [];
  for (let i = 0; i < safeMessages.length; i++) {
    if (orphanResultIndices.has(i)) continue; // drop
    const m = safeMessages[i];
    if (!m || typeof m !== 'object') {
      out.push(m);
      continue;
    }
    if (m.role !== 'assistant' || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const filtered = m.content.filter((part) => {
      if (!_TOOL_CALL_TYPES.has(part?.type)) return true;
      const id = _extractCallIdFromPart(part);
      if (!id) return true;
      return !orphanCallIds.has(id);
    });
    if (filtered.length === m.content.length) {
      out.push(m);
    } else if (filtered.length === 0) {
      // assistant 메시지 전체가 빌 경우 drop (turn 경계 유지는 user 메시지가 담당)
      continue;
    } else {
      out.push({ ...m, content: filtered });
    }
  }
  return {
    messages: out,
    sanitized: true,
    removedCallIds: Array.from(orphanCallIds),
    removedResultMessages: orphanResultIndices.size,
  };
}

function estimateToolOutputChars(messages = []) {
  let total = 0;
  for (const message of messages) {
    for (const part of normalizeContentParts(message?.content)) {
      if (part?.type === "toolResult" || part?.type === "toolCall") {
        total += JSON.stringify(part).length;
      }
    }
  }
  return total;
}

function countToolHeavyTurns(messages = []) {
  let turns = 0;
  for (const message of messages) {
    const hasTool = normalizeContentParts(message?.content).some((part) => part?.type === "toolResult" || part?.type === "toolCall");
    if (hasTool) turns += 1;
  }
  return turns;
}

function estimateContentChars(content) {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return String(content).length;
  }
}

export function estimateMessagesTokens(messages = []) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    chars += 24; // conservative per-message envelope/role overhead
    chars += estimateContentChars(message?.content);
    if (message?.role) chars += String(message.role).length;
    if (message?.name) chars += String(message.name).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function messageTokenEstimate(message) {
  return estimateMessagesTokens([message]);
}

function isPinnedPrefixMessage(message) {
  return message?.role === 'system' || message?.role === 'developer';
}

export function trimMessagesToBudget(messages = [], tokenBudget = 1, options = {}) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? Math.floor(tokenBudget) : 1;
  const targetRatio = Number.isFinite(options.targetRatio) && options.targetRatio > 0 && options.targetRatio < 1
    ? options.targetRatio
    : 0.72;
  const targetTokens = Math.max(1, Math.floor(budget * targetRatio));
  const estimatedTokens = estimateMessagesTokens(safeMessages);
  if (estimatedTokens <= targetTokens) {
    return { messages: safeMessages, estimatedTokens, trimmed: false, removedMessages: 0, targetTokens };
  }

  const prefix = [];
  let cursor = 0;
  while (cursor < safeMessages.length && isPinnedPrefixMessage(safeMessages[cursor])) {
    prefix.push(safeMessages[cursor]);
    cursor += 1;
  }

  const tail = [];
  let usedTokens = estimateMessagesTokens(prefix);
  for (let i = safeMessages.length - 1; i >= cursor; i -= 1) {
    const message = safeMessages[i];
    const nextTokens = messageTokenEstimate(message);
    if (tail.length > 0 && usedTokens + nextTokens > targetTokens) break;
    tail.unshift(message);
    usedTokens += nextTokens;
  }

  const trimmedMessages = [...prefix, ...tail];
  return {
    messages: trimmedMessages,
    estimatedTokens: estimateMessagesTokens(trimmedMessages),
    trimmed: trimmedMessages.length < safeMessages.length,
    removedMessages: Math.max(0, safeMessages.length - trimmedMessages.length),
    targetTokens,
  };
}

function buildSystemPromptAddition(decision) {
  return [
    "[SESSION BRANCH ENGINE]",
    `health=${decision.band}`,
    `strategy=${decision.strategy}`,
    `reasons=${decision.reasons.join(",")}`,
    "Preserve objective, confirmed facts, decisions, and next actions.",
    "Do not rehydrate discarded raw logs or redundant tool outputs.",
  ].join("\n");
}

const noopMediation = {
  async ingestTurnSummary(input) {
    return { no_claim: false, candidates: [], traces: [JSON.stringify({ stub: true, input })] };
  },
  async buildRecallSet() {
    return { items: [] };
  },
  async proposePatch() {
    return { patchId: 'stub-patch' };
  },
};

function buildMediationFromConfig(config = {}) {
  const memoryOwn = config?.memoryOwn ?? {};
  const httpDisabled = memoryOwn.disableHttp === true;
  const mode = memoryOwn.mode || 'async';
  const httpMediation = createHttpPhronesisMediation({
    baseUrl: memoryOwn.apiBase || 'http://127.0.0.1:8788',
    apiKey: memoryOwn.apiKey,
  });

  const queuedMediation = {
    async ingestTurnSummary(input) {
      return await enqueuePhronesisPayload(input);
    },
    async buildRecallSet(...args) {
      return await httpMediation.buildRecallSet(...args);
    },
    async proposePatch(...args) {
      return await httpMediation.proposePatch(...args);
    },
  };

  if (httpDisabled) return noopMediation;
  if (mode === 'sync') return httpMediation;
  return queuedMediation;
}

export default function register(api) {
  api.registerContextEngine("session-branch-engine", (config = {}) => ({
    info: {
      id: "session-branch-engine",
      name: "Session Branch Engine",
      version: "0.1.0",
      ownsCompaction: false,
      turnMaintenanceMode: "foreground",
    },

    async ingest() {
      return { ingested: true };
    },

    async assemble({ messages, tokenBudget }) {
      const safeMessages = Array.isArray(messages) ? messages : [];
      const originalEstimatedTokens = estimateMessagesTokens(safeMessages);
      const signals = deriveSignals({
        estimatedTokens: originalEstimatedTokens,
        effectiveBudget: tokenBudget || 1,
        toolOutputCharsRecent: estimateToolOutputChars(safeMessages),
        toolHeavyTurns: countToolHeavyTurns(safeMessages),
        recentTurns: safeMessages.length || 1,
      });
      const decision = chooseStrategy(signals, {
        subagentCandidate: signals.toolOutputCharsRecent >= 40000,
      });

      const sanitizeEnabled = config?.sanitizeToolPairs !== false;
      const sanitized = sanitizeEnabled
        ? sanitizeMessagesForToolPairs(safeMessages)
        : { messages: safeMessages, sanitized: false, removedCallIds: [], removedResultMessages: 0 };
      const sanitizeNotice = sanitized.sanitized
        ? `\nContext engine dropped ${sanitized.removedCallIds.length} orphan toolCall(s) and ${sanitized.removedResultMessages} orphan toolResult message(s) to keep tool-pair invariants.`
        : '';

      const targetRatio = Number.isFinite(config?.assembleTargetRatio) ? config.assembleTargetRatio : Math.min(config?.flushThreshold ?? 0.75, 0.72);
      const assembled = trimMessagesToBudget(sanitized.messages, tokenBudget || 1, { targetRatio });
      const trimNotice = assembled.trimmed
        ? `\nContext engine trimmed ${assembled.removedMessages} older message(s) to stay under ${assembled.targetTokens} estimated tokens.`
        : '';

      return {
        messages: assembled.messages,
        estimatedTokens: assembled.estimatedTokens,
        systemPromptAddition: `${buildSystemPromptAddition(decision)}${sanitizeNotice}${trimNotice}`,
      };
    },

    async maintain(params) {
      const signals = deriveSignals({
        estimatedTokens: params?.estimatedTokens ?? 0,
        effectiveBudget: params?.tokenBudget ?? 1,
        toolOutputCharsRecent: 0,
      });
      const decision = chooseStrategy(signals, {
        subagentCandidate: false,
      });
      const observe = applyObserveOnly(decision, config);
      return {
        ok: true,
        state: {
          health: decision.band,
          strategy: observe.strategy,
          recommendedStrategy: observe.recommendedStrategy,
          observeOnly: observe.observeOnly,
          reasons: decision.reasons,
          score: decision.score,
        },
      };
    },

    async afterTurn(params) {
      const strategy = params?.state?.recommendedStrategy ?? params?.state?.strategy ?? 'continue';
      const compactState = {
        objective: params?.objective ?? 'unknown-objective',
        confirmedFacts: params?.confirmedFacts ?? [],
        decisions: params?.decisions ?? [],
        completed: params?.completed ?? [],
        nextActions: params?.nextActions ?? [],
        risks: params?.risks ?? [],
        solidNodeId: params?.solidNodeId,
      };

      const externalValidation = await maybeRunExternalValidationLoop(params, config);

      if (!shouldIngestToPhronesis(strategy)) return { externalValidation };

      const mediation = buildMediationFromConfig(config);

      const phronesis = await handleAfterTurnWithPhronesis(mediation, {
        sessionKey: params?.sessionKey ?? 'unknown-session',
        runId: params?.runId,
        turnId: params?.turnId ?? 'unknown-turn',
        sourceChannel: params?.sourceChannel,
        strategy,
        compactState,
        health: {
          tokenRatio: params?.tokenRatio ?? 0,
          qualityDropSignal: params?.qualityDropSignal ?? false,
          branchInstability: params?.branchInstability ?? 0,
          toolOutputRatioRecent: params?.toolOutputRatioRecent,
          timeoutRecent: params?.timeoutRecent,
          errorRecent: params?.errorRecent,
        },
        evidenceRefs: (params?.evidenceRefs ?? []).map((ref) => ({
          conversationId: ref.conversationId,
          turnId: ref.turnId,
          spanStart: ref.spanStart,
          spanEnd: ref.spanEnd,
        })),
        createdAt: new Date().toISOString(),
      });

      return { externalValidation, phronesis };
    },

    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
