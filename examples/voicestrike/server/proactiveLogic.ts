/**
 * Pure, side-effect-free helpers for proactive Jarvis recommendations.
 * These are tested in isolation; main.ts wires them into the game loop.
 */

export interface RecommendGuardParams {
  ownedWeapons: string[];
  balance: number;
  lastRecommendTime: number;
  now: number;
  cooldownMs: number;
  enemyCount: number;
  shotgunPrice: number;
}

/**
 * Returns true when Jarvis should recommend buying the shotgun.
 *
 * Rules (all must pass):
 * 1. At least `ENEMY_THRESHOLD` enemies on screen (≥5 by default)
 * 2. Player does not already own the shotgun
 * 3. Player can afford the shotgun
 * 4. The cooldown since last recommendation has elapsed
 */
export function shouldRecommendShotgun(p: RecommendGuardParams): boolean {
  if (p.enemyCount < 5) return false;
  if (p.ownedWeapons.includes('shotgun')) return false;
  if (p.balance < p.shotgunPrice) return false;
  if (p.now - p.lastRecommendTime < p.cooldownMs) return false;
  return true;
}
