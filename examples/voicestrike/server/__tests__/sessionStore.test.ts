import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionStore, SESSION_TTL_MS } from '../sessionStore.js';

const MOCK_STATE = {
  balance: 1000,
  ownedWeapons: ['pistol'],
  equippedWeapon: 'pistol',
  health: 100,
  maxHealth: 100,
  wave: 1,
};

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves game state', () => {
    store.set('ch-1', MOCK_STATE);
    expect(store.get('ch-1')).toEqual(MOCK_STATE);
  });

  it('returns undefined for an unknown channel', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('deletes a session by channel', () => {
    store.set('ch-1', MOCK_STATE);
    store.delete('ch-1');
    expect(store.get('ch-1')).toBeUndefined();
  });

  it('overwrites an existing session with new state', () => {
    store.set('ch-1', MOCK_STATE);
    store.set('ch-1', { ...MOCK_STATE, balance: 500 });
    expect(store.get('ch-1')?.balance).toBe(500);
  });

  it('reports correct size', () => {
    expect(store.size()).toBe(0);
    store.set('ch-1', MOCK_STATE);
    store.set('ch-2', MOCK_STATE);
    expect(store.size()).toBe(2);
  });

  it('returns undefined for an expired session', () => {
    vi.useFakeTimers();
    store.set('ch-1', MOCK_STATE);
    vi.advanceTimersByTime(SESSION_TTL_MS + 1);
    expect(store.get('ch-1')).toBeUndefined();
  });

  it('a live session is still accessible just before TTL expires', () => {
    vi.useFakeTimers();
    store.set('ch-1', MOCK_STATE);
    vi.advanceTimersByTime(SESSION_TTL_MS - 1);
    expect(store.get('ch-1')).toEqual(MOCK_STATE);
  });

  it('renews expiry when the same channel is set again', () => {
    vi.useFakeTimers();
    store.set('ch-1', MOCK_STATE);
    vi.advanceTimersByTime(SESSION_TTL_MS - 1000); // almost expired
    store.set('ch-1', { ...MOCK_STATE, wave: 5 }); // renew
    vi.advanceTimersByTime(SESSION_TTL_MS - 1);    // advance again — still within new TTL
    expect(store.get('ch-1')?.wave).toBe(5);
  });
});
