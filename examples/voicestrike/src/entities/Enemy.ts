import Phaser from 'phaser';

export class Enemy extends Phaser.Physics.Arcade.Sprite {
  health: number;
  readonly maxHealth: number;
  private readonly speed: number;
  readonly damage: number;

  constructor(scene: Phaser.Scene, x: number, y: number, wave: number) {
    super(scene, x, y, 'enemy');
    scene.add.existing(this);
    scene.physics.add.existing(this);
    this.maxHealth = 20 + wave * 10;
    this.health = this.maxHealth;
    this.speed = 60 + wave * 5;
    this.damage = 10;
    (this.body as Phaser.Physics.Arcade.Body).setCircle(13, 3, 3);
  }

  update(playerX: number, playerY: number): void {
    if (!this.active || this.health <= 0) return;
    this.scene.physics.moveTo(this, playerX, playerY, this.speed);
    const angle = Phaser.Math.Angle.Between(this.x, this.y, playerX, playerY);
    this.setRotation(angle);
  }

  takeDamage(amount: number): boolean {
    // Guard: two projectiles can overlap the same enemy in one physics step
    if (this.health <= 0) return false;
    this.health -= amount;
    this.setTint(0xffffff);
    this.scene.time.delayedCall(80, () => {
      if (this.active) this.clearTint();
    });
    if (this.health <= 0) {
      this.destroy();
      return true;
    }
    return false;
  }
}
