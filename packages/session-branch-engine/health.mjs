export const DEFAULT_THRESHOLDS = {
  soft: 0.6,
  flush: 0.75,
  emergency: 0.85,
  clearToolChars: 40000,
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function normalizeLatencyGrowth(value) {
  if (!Number.isFinite(value) || value <= 1) return 0;
  return clamp01((value - 1) / 2);
}

export function classifyHealth({
  tokenRatio = 0,
  toolOutputRatioRecent = 0,
  normalizedLatencyGrowth = 0,
  errorBurstScore = 0,
  branchInstabilityScore = 0,
  qualityDropScore = 0,
  hardCritical = false,
}) {
  if (hardCritical) {
    return { score: 1, band: "critical" };
  }

  const score = clamp01(
    0.35 * clamp01(tokenRatio) +
      0.15 * clamp01(toolOutputRatioRecent) +
      0.15 * clamp01(normalizedLatencyGrowth) +
      0.15 * clamp01(errorBurstScore) +
      0.1 * clamp01(branchInstabilityScore) +
      0.1 * clamp01(qualityDropScore),
  );

  let band = "healthy";
  if (score >= 0.8) band = "critical";
  else if (score >= 0.6) band = "degrading";
  else if (score >= 0.4) band = "warning";

  return { score, band };
}

export function deriveSignals({
  estimatedTokens = 0,
  effectiveBudget = 1,
  toolOutputCharsRecent = 0,
  toolHeavyTurns = 0,
  recentTurns = 1,
  latencyGrowth = 1,
  errorRecent = 0,
  timeoutRecent = 0,
  branchInstability = 0,
  qualityDropSignal = false,
  promptTooLong = false,
  stuckRunSignal = false,
  overloadRecent = 0,
}) {
  const tokenRatio = effectiveBudget > 0 ? estimatedTokens / effectiveBudget : 0;
  const toolOutputRatioRecent = recentTurns > 0 ? toolHeavyTurns / recentTurns : 0;
  const hardCritical =
    promptTooLong ||
    stuckRunSignal ||
    (overloadRecent >= 2 && tokenRatio >= 0.7) ||
    errorRecent >= 3;

  return {
    estimatedTokens,
    effectiveBudget,
    tokenRatio: clamp01(tokenRatio),
    toolOutputCharsRecent,
    toolOutputRatioRecent: clamp01(toolOutputRatioRecent),
    normalizedLatencyGrowth: normalizeLatencyGrowth(latencyGrowth),
    errorBurstScore: clamp01((errorRecent + timeoutRecent) / 4),
    branchInstabilityScore: clamp01(branchInstability / 3),
    qualityDropScore: qualityDropSignal ? 1 : 0,
    hardCritical,
    promptTooLong,
    stuckRunSignal,
    overloadRecent,
  };
}
