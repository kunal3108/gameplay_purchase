import Phaser from 'phaser';
import { WeaponBase } from './WeaponBase';
import type { FireContext } from '../types/game';

export class Shotgun extends WeaponBase {
  readonly name = 'Shotgun';
  readonly cooldown = 700;
  private readonly damage = 15;
  private readonly pelletSpeed = 520;
  private readonly pelletCount = 5;
  private readonly spread = 0.42; // total arc in radians (~24°)

  fire(ctx: FireContext): void {
    if (!this.canFire(ctx.time)) return;
    this.lastFired = ctx.time;

    for (let i = 0; i < this.pelletCount; i++) {
      const offset = (i - (this.pelletCount - 1) / 2) * (this.spread / (this.pelletCount - 1));
      const angle = ctx.angle + offset;
      const p = ctx.bullets.create(ctx.origin.x, ctx.origin.y, 'pellet') as unknown as Phaser.Physics.Arcade.Sprite;
      if (!p) continue;
      p.setData('damage', this.damage);
      p.setRotation(angle);
      p.setVelocity(
        Math.cos(angle) * this.pelletSpeed,
        Math.sin(angle) * this.pelletSpeed,
      );
      p.setDepth(3);
    }
  }
}
