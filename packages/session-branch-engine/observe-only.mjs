export function applyObserveOnly(decision, config = {}) {
  const observeOnly = config?.observeOnly === true;
  return {
    observeOnly,
    strategy: observeOnly ? 'continue' : decision.strategy,
    recommendedStrategy: decision.strategy,
  };
}
