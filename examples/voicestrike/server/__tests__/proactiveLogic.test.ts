import { describe, it, expect } from 'vitest';
import { shouldRecommendShotgun } from '../proactiveLogic.js';
import type { RecommendGuardParams } from '../proactiveLogic.js';

const BASE: RecommendGuardParams = {
  ownedWeapons: ['pistol'],
  balance: 400,
  lastRecommendTime: 0,
  now: 70_000, // 70 s since epoch — well past 60 s cooldown
  cooldownMs: 60_000,
  enemyCount: 5,
  shotgunPrice: 300,
};

describe('shouldRecommendShotgun', () => {
  it('returns true when all conditions are met', () => {
    expect(shouldRecommendShotgun(BASE)).toBe(true);
  });

  it('returns false when enemy count is below threshold', () => {
    expect(shouldRecommendShotgun({ ...BASE, enemyCount: 4 })).toBe(false);
  });

  it('returns false when player already owns shotgun', () => {
    expect(shouldRecommendShotgun({ ...BASE, ownedWeapons: ['pistol', 'shotgun'] })).toBe(false);
  });

  it('returns false when player cannot afford shotgun', () => {
    expect(shouldRecommendShotgun({ ...BASE, balance: 299 })).toBe(false);
  });

  it('returns false when within cooldown window', () => {
    expect(shouldRecommendShotgun({ ...BASE, lastRecommendTime: 50_000, now: 60_000 })).toBe(false);
  });

  it('returns true exactly at cooldown boundary', () => {
    expect(shouldRecommendShotgun({ ...BASE, lastRecommendTime: 0, now: 60_000 })).toBe(true);
  });

  it('returns false with enemy count exactly at threshold minus one', () => {
    expect(shouldRecommendShotgun({ ...BASE, enemyCount: 4 })).toBe(false);
  });

  it('returns true with enemy count exactly at threshold', () => {
    expect(shouldRecommendShotgun({ ...BASE, enemyCount: 5 })).toBe(true);
  });

  it('returns false when balance equals price minus one', () => {
    expect(shouldRecommendShotgun({ ...BASE, balance: 299 })).toBe(false);
  });

  it('returns true when balance exactly equals price', () => {
    expect(shouldRecommendShotgun({ ...BASE, balance: 300 })).toBe(true);
  });
});
