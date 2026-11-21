import { describe, it, expect } from 'vitest';
import { getEnemiesForWave } from '../waveConfig.js';

describe('getEnemiesForWave', () => {
  it('wave 1 returns 2 (grace-period start)', () => {
    expect(getEnemiesForWave(1)).toBe(2);
  });

  it('wave 2 returns 4', () => {
    expect(getEnemiesForWave(2)).toBe(4);
  });

  it('wave 3 returns 6 (first wave ≥5 — triggers shotgun recommendation)', () => {
    expect(getEnemiesForWave(3)).toBe(6);
  });

  it('wave 4 uses the linear formula (5 + (wave-1)*3 = 14)', () => {
    expect(getEnemiesForWave(4)).toBe(14);
  });

  it('wave 5 returns 17', () => {
    expect(getEnemiesForWave(5)).toBe(17);
  });

  it('wave 10 returns 32', () => {
    expect(getEnemiesForWave(10)).toBe(32);
  });

  it('wave counts strictly increase from wave 1 to wave 10', () => {
    let prev = getEnemiesForWave(1);
    for (let w = 2; w <= 10; w++) {
      const curr = getEnemiesForWave(w);
      expect(curr).toBeGreaterThan(prev);
      prev = curr;
    }
  });

  it('wave 3 is the first wave with ≥5 enemies', () => {
    expect(getEnemiesForWave(1)).toBeLessThan(5);
    expect(getEnemiesForWave(2)).toBeLessThan(5);
    expect(getEnemiesForWave(3)).toBeGreaterThanOrEqual(5);
  });

  it('throws RangeError for wave 0', () => {
    expect(() => getEnemiesForWave(0)).toThrow(RangeError);
  });

  it('throws RangeError for negative wave numbers', () => {
    expect(() => getEnemiesForWave(-1)).toThrow(RangeError);
  });
});
