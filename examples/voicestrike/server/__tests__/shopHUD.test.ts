import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { categorizeWeapons, HighlightTimer } from '../shopHUDLogic.js';
import type { WeaponEntry } from '../shopHUDLogic.js';

const CATALOGUE: WeaponEntry[] = [
  { id: 'pistol',  name: 'Pistol',    price: 0   },
  { id: 'shotgun', name: 'Shotgun',   price: 300 },
  { id: 'laser',   name: 'Laser Gun', price: 500 },
];

describe('categorizeWeapons', () => {
  it('basic categorization — owned weapons go to arsenal, unowned to armory', () => {
    const result = categorizeWeapons(CATALOGUE, ['pistol'], 'pistol', 350);
    expect(result.arsenal).toHaveLength(1);
    expect(result.arsenal[0]!.id).toBe('pistol');
    expect(result.armory).toHaveLength(2);
    const armoryIds = result.armory.map(w => w.id);
    expect(armoryIds).toContain('shotgun');
    expect(armoryIds).toContain('laser');
  });

  it('equipped weapon is flagged correctly in arsenal', () => {
    const result = categorizeWeapons(CATALOGUE, ['pistol', 'shotgun'], 'shotgun', 500);
    const pistolEntry = result.arsenal.find(w => w.id === 'pistol')!;
    const shotgunEntry = result.arsenal.find(w => w.id === 'shotgun')!;
    expect(pistolEntry.equipped).toBe(false);
    expect(shotgunEntry.equipped).toBe(true);
  });

  it('canAfford is true when balance >= price, false otherwise', () => {
    const result = categorizeWeapons(CATALOGUE, ['pistol'], 'pistol', 300);
    const shotgun = result.armory.find(w => w.id === 'shotgun')!;
    const laser = result.armory.find(w => w.id === 'laser')!;
    expect(shotgun.canAfford).toBe(true);   // balance 300 === price 300
    expect(laser.canAfford).toBe(false);    // balance 300 < price 500
  });

  it('all owned — empty armory', () => {
    const result = categorizeWeapons(CATALOGUE, ['pistol', 'shotgun', 'laser'], 'pistol', 999);
    expect(result.arsenal).toHaveLength(3);
    expect(result.armory).toHaveLength(0);
  });

  it('none owned — empty arsenal', () => {
    const result = categorizeWeapons(CATALOGUE, [], '', 999);
    expect(result.arsenal).toHaveLength(0);
    expect(result.armory).toHaveLength(3);
  });

  it('credit update — balance change is reflected in canAfford', () => {
    // First check with 0 coins — cannot afford anything
    const broke = categorizeWeapons(CATALOGUE, ['pistol'], 'pistol', 0);
    expect(broke.armory.find(w => w.id === 'shotgun')!.canAfford).toBe(false);
    expect(broke.armory.find(w => w.id === 'laser')!.canAfford).toBe(false);

    // After earning 300 coins — can afford shotgun but not laser
    const rich = categorizeWeapons(CATALOGUE, ['pistol'], 'pistol', 300);
    expect(rich.armory.find(w => w.id === 'shotgun')!.canAfford).toBe(true);
    expect(rich.armory.find(w => w.id === 'laser')!.canAfford).toBe(false);
  });
});

describe('HighlightTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('highlights the correct weapon IDs and area', () => {
    const timer = new HighlightTimer(5_000);
    timer.highlight(['shotgun', 'laser'], 'armory');
    expect(timer.getActiveIds()).toEqual(['shotgun', 'laser']);
    expect(timer.getActiveArea()).toBe('armory');
    expect(timer.isActive('shotgun')).toBe(true);
    expect(timer.isActive('pistol')).toBe(false);
    timer.clear();
  });

  it('clears after the timeout elapses', () => {
    const timer = new HighlightTimer(5_000);
    timer.highlight(['shotgun'], 'armory');
    expect(timer.getActiveIds()).toHaveLength(1);

    vi.advanceTimersByTime(5_001);

    expect(timer.getActiveIds()).toHaveLength(0);
    expect(timer.getActiveArea()).toBeNull();
  });

  it('repeated highlight() resets the timer', () => {
    const timer = new HighlightTimer(5_000);
    timer.highlight(['shotgun'], 'armory');

    // Advance almost to expiry, then re-highlight
    vi.advanceTimersByTime(4_900);
    timer.highlight(['laser'], 'armory');

    // The original timeout would have fired at t=5000; we're at t=4900.
    // After re-highlight, the new timeout fires at t=4900+5000=9900.
    vi.advanceTimersByTime(2_000); // t=6900 — old timer would have cleared by now
    expect(timer.getActiveIds()).toEqual(['laser']); // still active due to reset

    vi.advanceTimersByTime(3_200); // t=10100 — past new timeout
    expect(timer.getActiveIds()).toHaveLength(0);
  });

  it('different area on each highlight call', () => {
    const timer = new HighlightTimer(5_000);

    timer.highlight(['pistol'], 'arsenal');
    expect(timer.getActiveArea()).toBe('arsenal');

    timer.highlight(['shotgun'], 'armory');
    expect(timer.getActiveArea()).toBe('armory');

    timer.clear();
  });

  it('clear() stops the timer and resets state immediately', () => {
    const timer = new HighlightTimer(5_000);
    timer.highlight(['laser'], 'armory');
    expect(timer.getActiveIds()).toHaveLength(1);

    timer.clear();

    expect(timer.getActiveIds()).toHaveLength(0);
    expect(timer.getActiveArea()).toBeNull();

    // Advancing timers should not throw or trigger further effects
    vi.advanceTimersByTime(10_000);
    expect(timer.getActiveIds()).toHaveLength(0);
  });
});
