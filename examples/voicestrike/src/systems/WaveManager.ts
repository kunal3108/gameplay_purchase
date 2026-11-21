import Phaser from 'phaser';
import { Enemy } from '../entities/Enemy';

/**
 * Enemy count per wave:
 * - Wave 1: 2  (easy start; player has 8s grace period to orient + hear Jarvis)
 * - Wave 2: 4
 * - Wave 3: 6  ← first wave with ≥5 enemies (triggers proactive shotgun recommendation)
 * - Wave 4+:  5 + (wave − 1) × 3
 */
export function enemiesForWave(wave: number): number {
  if (wave === 1) return 2;
  if (wave === 2) return 4;
  if (wave === 3) return 6;
  return 5 + (wave - 1) * 3;
}

export class WaveManager {
  private wave = 0;
  private enemiesThisWave = 0;
  private enemiesSpawned = 0;
  private spawning = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly enemies: Phaser.Physics.Arcade.Group,
  ) {}

  /**
   * Schedule the first wave after a grace period.
   * Uses scene.time, so it automatically pauses/resumes with the scene clock.
   */
  scheduleFirstWave(gracePeriodMs = 8_000): void {
    this.scene.time.delayedCall(gracePeriodMs, () => { this.startNextWave(); });
  }

  startNextWave(): void {
    this.wave++;
    this.enemiesThisWave = enemiesForWave(this.wave);
    this.enemiesSpawned = 0;
    this.spawning = true;
    this.scene.events.emit('waveChanged', this.wave);
    this.scene.time.addEvent({
      delay: 700,
      callback: this.spawnOne,
      callbackScope: this,
      repeat: this.enemiesThisWave - 1,
    });
  }

  private spawnOne(): void {
    this.enemiesSpawned++;
    const { width } = this.scene.scale;
    // Enemies enter from the top edge — well away from the player who starts at y=500
    const x = Phaser.Math.Between(40, width - 40);
    const y = Phaser.Math.Between(-30, -8);
    const enemy = new Enemy(this.scene, x, y, this.wave);
    this.enemies.add(enemy, true);
    if (this.enemiesSpawned >= this.enemiesThisWave) {
      this.spawning = false;
    }
  }

  get currentWave(): number {
    return this.wave;
  }

  isWaveComplete(): boolean {
    return !this.spawning && this.enemies.countActive(true) === 0;
  }
}
