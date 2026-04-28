import type {
  TurnSummaryInput,
  PhronesisMediation,
  IngestResult,
  CompactionStrategy,
} from '../../../docs/memory-v1a-types';

export interface CompactStateLike {
  objective: string;
  confirmedFacts?: string[];
  decisions?: string[];
  completed?: string[];
  nextActions?: string[];
  risks?: string[];
  solidNodeId?: string;
}

export interface AfterTurnLike {
  sessionKey: string;
  runId?: string;
  turnId: string;
  sourceChannel?: string;
  strategy: CompactionStrategy;
  compactState: CompactStateLike;
  health: {
    tokenRatio: number;
    qualityDropSignal: boolean;
    branchInstability: number;
    toolOutputRatioRecent?: number;
    timeoutRecent?: number;
    errorRecent?: number;
  };
  evidenceRefs: Array<{
    conversationId: string;
    turnId: string;
    spanStart?: number;
    spanEnd?: number;
  }>;
  createdAt: string;
}

export function buildTurnSummaryInput(input: AfterTurnLike): TurnSummaryInput {
  return {
    sessionKey: input.sessionKey,
    runId: input.runId,
    turnId: input.turnId,
    sourceChannel: input.sourceChannel,
    objective: input.compactState.objective,
    strategy: input.strategy,
    solidNodeId: input.compactState.solidNodeId,
    confirmedFacts: input.compactState.confirmedFacts ?? [],
    decisions: input.compactState.decisions ?? [],
    completed: input.compactState.completed ?? [],
    nextActions: input.compactState.nextActions ?? [],
    risks: input.compactState.risks ?? [],
    health: input.health,
    evidenceRefs: input.evidenceRefs.map((ref) => ({
      sourceType: 'conversation',
      conversationId: ref.conversationId,
      turnId: ref.turnId,
      spanStart: ref.spanStart,
      spanEnd: ref.spanEnd,
    })),
    createdAt: input.createdAt,
  };
}

export async function handleAfterTurnWithPhronesis(
  mediation: PhronesisMediation,
  afterTurn: AfterTurnLike,
): Promise<IngestResult | null> {
  if (afterTurn.strategy === 'continue') return null;
  if (afterTurn.strategy === 'clear') return null;

  const payload = buildTurnSummaryInput(afterTurn);

  if (afterTurn.strategy === 'rewind') {
    payload.candidateHints = {
      sourceDomain: 'reflection_lesson',
      likelySemanticType: 'procedure',
      pillar: 'reflection',
      importance: 0.6,
    };
  }

  if (afterTurn.strategy === 'compact') {
    payload.candidateHints = {
      sourceDomain: 'preference_intent',
      likelySemanticType: 'procedure',
      pillar: 'reflection',
      importance: 0.8,
    };
  }

  if (afterTurn.strategy === 'subagent') {
    payload.candidateHints = {
      sourceDomain: 'task_result',
      likelySemanticType: 'claim',
      pillar: 'praxis',
      importance: 0.75,
    };
  }

  return mediation.ingestTurnSummary(payload);
}
