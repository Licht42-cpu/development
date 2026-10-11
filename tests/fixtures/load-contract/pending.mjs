// These names describe test files, never fields in a backend request/response.
export function pendingScenario(scenarioLabel) {
  return Object.freeze({
    scenarioLabel,
    readContractExamples() {
      throw new Error(`TODO: frozen 10.1 load contract examples required for ${scenarioLabel}`);
    }
  });
}
