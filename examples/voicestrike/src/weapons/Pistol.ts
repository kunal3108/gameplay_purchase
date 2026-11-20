import Phaser from 'phaser';
import { WeaponBase } from './WeaponBase';
import type { FireContext } from '../types/game';

export class Pistol extends WeaponBase {
  readonly name = 'Pistol';
  readonly cooldown = 300;
  private readonly damage = 25;
  private readonly bulletSpeed = 650;

  fire(ctx: FireContext): void {
    if (!this.canFire(ctx.time)) return;
    this.lastFired = ctx.time;

    // Use group.create() so the physics body is owned by the group from birth.
    // Using physics.add.sprite() + group.add() causes the group to call
    // enableBody again, which resets velocity to zero — the "mine" bug.
    const b = ctx.bullets.create(ctx.origin.x, ctx.origin.y, 'bullet') as unknown as Phaser.Physics.Arcade.Sprite;
    if (!b) return;
    b.setData('damage', this.damage);
    b.setRotation(ctx.angle);
    b.setVelocity(
      Math.cos(ctx.angle) * this.bulletSpeed,
      Math.sin(ctx.angle) * this.bulletSpeed,
    );
    b.setDepth(3);
  }
}
