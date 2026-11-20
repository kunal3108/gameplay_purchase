import type { FireContext } from '../types/game';

export abstract class WeaponBase {
  abstract readonly name: string;
  abstract readonly cooldown: number;
  protected lastFired = 0;

  get lastFiredTime(): number {
    return this.lastFired;
  }

  canFire(time: number): boolean {
    return time - this.lastFired >= this.cooldown;
  }

  abstract fire(ctx: FireContext): void;
}
