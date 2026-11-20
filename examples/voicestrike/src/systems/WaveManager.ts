import Phaser from 'phaser';
import { Enemy } from '../entities/Enemy';

export class WaveManager {
  private wave = 0;
  private enemiesThisWave = 0;
  private enemiesSpawned = 0;
  private spawning = false;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly enemies: Phaser.Physics.Arcade.Group,
  ) {}

  startNextWave(): void {
    this.wave++;
    this.enemiesThisWave = 5 + (this.wave - 1) * 3;
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
    // Enemies always enter from the northern/top edge and advance downward
    const x = Phaser.Math.Between(40, width - 40);
    const y = Phaser.Math.Between(-30, -8);   // just above the visible area
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
