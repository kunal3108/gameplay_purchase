import Phaser from 'phaser';
import { WeaponBase } from './WeaponBase';
import type { FireContext } from '../types/game';

export class LaserGun extends WeaponBase {
  readonly name = 'Laser';
  readonly cooldown = 0;
  private readonly damage = 8;
  private readonly damageInterval = 100;
  private lastDamageTime = 0;

  fire(ctx: FireContext): void {
    const maxDist = 1200;
    let endX = ctx.origin.x + Math.cos(ctx.angle) * maxDist;
    let endY = ctx.origin.y + Math.sin(ctx.angle) * maxDist;

    const ray = new Phaser.Geom.Line(ctx.origin.x, ctx.origin.y, endX, endY);
    let closestDist = Infinity;
    let hitEnemy: Phaser.GameObjects.GameObject | null = null;

    for (const child of ctx.enemies.getChildren()) {
      if (!child.active) continue;
      const sprite = child as Phaser.Physics.Arcade.Sprite;
      const bounds = sprite.getBounds();
      if (Phaser.Geom.Intersects.LineToRectangle(ray, bounds)) {
        const dist = Phaser.Math.Distance.Between(ctx.origin.x, ctx.origin.y, sprite.x, sprite.y);
        if (dist < closestDist) {
          closestDist = dist;
          hitEnemy = child;
          endX = sprite.x;
          endY = sprite.y;
        }
      }
    }

    // Glow (draw wide then narrow)
    ctx.laserGraphics.lineStyle(8, 0xff0044, 0.25);
    ctx.laserGraphics.lineBetween(ctx.origin.x, ctx.origin.y, endX, endY);
    ctx.laserGraphics.lineStyle(2, 0xff88aa, 1);
    ctx.laserGraphics.lineBetween(ctx.origin.x, ctx.origin.y, endX, endY);

    if (hitEnemy && ctx.time - this.lastDamageTime >= this.damageInterval) {
      this.lastDamageTime = ctx.time;
      ctx.onHitEnemy(hitEnemy, this.damage);
    }
  }
}
