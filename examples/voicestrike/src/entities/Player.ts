import Phaser from 'phaser';

export class Player extends Phaser.Physics.Arcade.Sprite {
  health: number;
  readonly maxHealth: number;
  private invulnerableUntil = 0;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, 'player');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.maxHealth = 100;
    this.health = this.maxHealth;
    this.setCollideWorldBounds(true);
    (this.body as Phaser.Physics.Arcade.Body).setCircle(12, 4, 4);
  }

  takeDamage(amount: number, time: number): void {
    if (time < this.invulnerableUntil || this.health <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.invulnerableUntil = time + 500;
    this.setTint(0xff4444);
    this.scene.time.delayedCall(200, () => {
      if (this.active) this.clearTint();
    });
  }

  isAlive(): boolean {
    return this.health > 0;
  }
}
