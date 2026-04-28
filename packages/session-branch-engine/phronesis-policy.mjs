export function shouldIngestToPhronesis(strategy) {
  return strategy !== 'continue' && strategy !== 'clear';
}

export function buildCandidateHints(strategy) {
  if (strategy === 'rewind') {
    return {
      sourceDomain: 'reflection_lesson',
      likelySemanticType: 'procedure',
      pillar: 'reflection',
      importance: 0.6,
    };
  }

  if (strategy === 'compact') {
    return {
      sourceDomain: 'preference_intent',
      likelySemanticType: 'procedure',
      pillar: 'reflection',
      importance: 0.8,
    };
  }

  if (strategy === 'subagent') {
    return {
      sourceDomain: 'task_result',
      likelySemanticType: 'claim',
      pillar: 'praxis',
      importance: 0.75,
    };
  }

  return undefined;
}
