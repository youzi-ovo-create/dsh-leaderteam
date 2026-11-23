// Per-stage recovery admission.
// Single-turn output-token truncation (`max-tokens`) is recovered via unified resident continuation
// and the multi-node Circuit Breaker Investigator — NEVER by refusing dispatch or forcing stage re-splitting.
export function assertRecoveryStrategy(_store, _candidate) {
  // No-op: output truncation no longer poisons stage/model dispatch or forces re-review.
}
