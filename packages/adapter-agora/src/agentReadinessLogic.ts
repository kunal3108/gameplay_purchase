/**
 * Pure state-machine logic for agent readiness.
 * No browser or Agora SDK dependencies — fully testable in Node.
 *
 * This module captures the decision rules for how the voice adapter
 * transitions out of 'connecting' state:
 *
 *   invite failed                 → error-invite-failed  (don't wait for audio that never comes)
 *   invite succeeded + published  → connected            (normal happy path)
 *   invite succeeded + timed out  → error-timeout        (Agora cloud unreachable / slow)
 */

export type InviteOutcome = 'success' | 'http-error' | 'network-error';
export type AgentReadyOutcome = 'connected' | 'error-invite-failed' | 'error-timeout';

/**
 * Given the terminal observations for a connection attempt, return the
 * appropriate agent-ready outcome.
 *
 * Note: `agentPublished` beats `timedOut` — if the audio arrives the same
 * tick the timer fires, the successful publish wins.
 */
export function determineAgentReadyOutcome(
  inviteOutcome: InviteOutcome,
  agentPublished: boolean,
  timedOut: boolean,
): AgentReadyOutcome {
  if (inviteOutcome !== 'success') return 'error-invite-failed';
  if (agentPublished) return 'connected';
  if (timedOut) return 'error-timeout';
  // Guard: should not be called until one of the above is true
  return 'connected';
}

/** User-visible error message for each error outcome. */
export function agentReadyErrorMessage(outcome: 'error-invite-failed' | 'error-timeout'): string {
  if (outcome === 'error-invite-failed') {
    return 'Voice AI offline — game continues without Jarvis. Click Retry to reconnect.';
  }
  return 'Jarvis did not respond within 15 s — Agora cloud unreachable. Click Retry to reconnect.';
}
