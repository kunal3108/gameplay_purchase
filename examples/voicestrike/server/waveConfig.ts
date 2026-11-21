/**
 * Pure wave-configuration logic — no Phaser dependency.
 * Mirrors enemiesForWave() in WaveManager.ts; kept separate so the
 * server test suite can import it without a browser environment.
 *
 * Enemy count per wave:
 *   Wave 1: 2  (easy start; 8 s grace period lets the player orient)
 *   Wave 2: 4
 *   Wave 3: 6  ← first wave with ≥5 enemies (triggers shotgun recommendation)
 *   Wave 4+: 5 + (wave − 1) × 3
 */
export function getEnemiesForWave(wave: number): number {
  if (wave < 1) throw new RangeError(`wave must be ≥ 1, got ${wave}`);
  if (wave === 1) return 2;
  if (wave === 2) return 4;
  if (wave === 3) return 6;
  return 5 + (wave - 1) * 3;
}
