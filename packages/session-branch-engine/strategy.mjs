import { DEFAULT_THRESHOLDS, classifyHealth } from "./health.mjs";

export function chooseStrategy(signals, options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const { score, band } = classifyHealth(signals);
  const reasons = [];

  if (signals.hardCritical) {
    if (signals.promptTooLong) {
      return { strategy: "compact", band: "critical", score, reasons: ["prompt_too_long"] };
    }

    if (signals.stuckRunSignal) {
      return { strategy: "rewind", band: "critical", score, reasons: ["stuck_run"] };
    }

    if (signals.toolOutputCharsRecent >= thresholds.clearToolChars || signals.toolOutputRatioRecent >= 0.45) {
      return { strategy: "clear", band: "critical", score, reasons: ["hard_critical", "tool_output_heavy"] };
    }

    return { strategy: "compact", band: "critical", score, reasons: ["hard_critical"] };
  }

  if (signals.promptTooLong) {
    return { strategy: "compact", band: "critical", score, reasons: ["prompt_too_long"] };
  }

  if (signals.stuckRunSignal) {
    return { strategy: "rewind", band: "critical", score, reasons: ["stuck_run"] };
  }

  if (signals.tokenRatio >= thresholds.emergency) {
    reasons.push("token_ratio_emergency");
    if (signals.toolOutputCharsRecent >= thresholds.clearToolChars) {
      reasons.push("tool_output_bloat");
      return { strategy: "clear", band: "critical", score, reasons };
    }
    return { strategy: "compact", band: "critical", score, reasons };
  }

  if (options.explorationHeavy === true && options.subagentCandidate === true) {
    reasons.push("exploration_heavy");
    return { strategy: "subagent", band, score, reasons };
  }

  if (signals.tokenRatio >= thresholds.flush) {
    reasons.push("token_ratio_flush");
    if (signals.toolOutputCharsRecent >= thresholds.clearToolChars || signals.toolOutputRatioRecent >= 0.45) {
      reasons.push("tool_output_heavy");
      return { strategy: "clear", band: "degrading", score, reasons };
    }
    return { strategy: "compact", band: "degrading", score, reasons };
  }

  if ((options.branchInstability ?? 0) >= 2 && options.hasSolidNode === true && options.invalidatingTurns >= 2) {
    reasons.push("branch_instability");
    return { strategy: "rewind", band, score, reasons };
  }

  if (signals.tokenRatio >= thresholds.soft) {
    reasons.push("token_ratio_soft");
    if (options.subagentCandidate === true) {
      reasons.push("subagent_candidate");
      return { strategy: "subagent", band, score, reasons };
    }
  }

  return { strategy: "continue", band, score, reasons: reasons.length ? reasons : ["healthy"] };
}
