import { describe, it, expect } from 'vitest';
import {
  determineAgentReadyOutcome,
  agentReadyErrorMessage,
} from '../agentReadinessLogic.js';

// ─── determineAgentReadyOutcome ───────────────────────────────────────────────

describe('determineAgentReadyOutcome — invite failure', () => {
  it('returns error-invite-failed on HTTP error (agent server down / 500)', () => {
    expect(determineAgentReadyOutcome('http-error', false, false)).toBe('error-invite-failed');
  });

  it('returns error-invite-failed on network error (server unreachable)', () => {
    expect(determineAgentReadyOutcome('network-error', false, false)).toBe('error-invite-failed');
  });

  it('invite failure takes priority over agentPublished (impossible in practice but guarded)', () => {
    expect(determineAgentReadyOutcome('http-error', true, false)).toBe('error-invite-failed');
  });

  it('invite failure takes priority over timedOut', () => {
    expect(determineAgentReadyOutcome('network-error', false, true)).toBe('error-invite-failed');
  });
});

describe('determineAgentReadyOutcome — 15 s timeout', () => {
  it('returns error-timeout when invite succeeded but agent never published audio', () => {
    expect(determineAgentReadyOutcome('success', false, true)).toBe('error-timeout');
  });

  it('does NOT return error-timeout when agent published before timeout fired', () => {
    expect(determineAgentReadyOutcome('success', true, false)).not.toBe('error-timeout');
  });
});

describe('determineAgentReadyOutcome — successful agent readiness', () => {
  it('returns connected when agent publishes audio before timeout', () => {
    expect(determineAgentReadyOutcome('success', true, false)).toBe('connected');
  });

  it('returns connected when agent publishes audio (timeout also fired — publish wins)', () => {
    // Race: timer and user-published event arrive same tick; agentPublished flag wins.
    expect(determineAgentReadyOutcome('success', true, true)).toBe('connected');
  });
});

// ─── agentReadyErrorMessage ───────────────────────────────────────────────────

describe('agentReadyErrorMessage', () => {
  it('invite-failed message mentions "offline" and "Retry"', () => {
    const msg = agentReadyErrorMessage('error-invite-failed');
    expect(msg).toMatch(/offline/i);
    expect(msg).toMatch(/retry/i);
  });

  it('timeout message mentions the 15 s limit and "Retry"', () => {
    const msg = agentReadyErrorMessage('error-timeout');
    expect(msg).toMatch(/15/);
    expect(msg).toMatch(/retry/i);
  });

  it('invite-failed and timeout messages are distinct', () => {
    expect(agentReadyErrorMessage('error-invite-failed')).not.toBe(
      agentReadyErrorMessage('error-timeout'),
    );
  });
});
