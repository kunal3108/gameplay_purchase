import { describe, it, expect } from 'vitest';
import { getRotatedWeaponId } from '../weaponRotationLogic.js';

describe('getRotatedWeaponId', () => {
  const owned = ['pistol', 'shotgun', 'laser'];

  it('advances forward by one slot', () => {
    expect(getRotatedWeaponId(owned, 'pistol', 1)).toBe('shotgun');
    expect(getRotatedWeaponId(owned, 'shotgun', 1)).toBe('laser');
  });

  it('wraps forward from last weapon back to first', () => {
    expect(getRotatedWeaponId(owned, 'laser', 1)).toBe('pistol');
  });

  it('goes backward by one slot', () => {
    expect(getRotatedWeaponId(owned, 'laser', -1)).toBe('shotgun');
    expect(getRotatedWeaponId(owned, 'shotgun', -1)).toBe('pistol');
  });

  it('wraps backward from first weapon to last', () => {
    expect(getRotatedWeaponId(owned, 'pistol', -1)).toBe('laser');
  });

  it('returns null when only one weapon is owned', () => {
    expect(getRotatedWeaponId(['pistol'], 'pistol', 1)).toBeNull();
    expect(getRotatedWeaponId(['pistol'], 'pistol', -1)).toBeNull();
  });

  it('returns null when no weapons are owned', () => {
    expect(getRotatedWeaponId([], 'pistol', 1)).toBeNull();
  });

  it('defaults to index 0 when currentId is not in list', () => {
    // currentId not found → start from 0, so +1 → index 1
    const result = getRotatedWeaponId(['pistol', 'shotgun'], 'unknown', 1);
    expect(result).toBe('shotgun');
  });

  it('works with two weapons', () => {
    const two = ['pistol', 'shotgun'];
    expect(getRotatedWeaponId(two, 'pistol', 1)).toBe('shotgun');
    expect(getRotatedWeaponId(two, 'shotgun', 1)).toBe('pistol');
    expect(getRotatedWeaponId(two, 'shotgun', -1)).toBe('pistol');
  });
});
