import Phaser from 'phaser';

export type WeaponId = 'pistol' | 'shotgun' | 'laser';

export interface FireContext {
  time: number;
  origin: Phaser.Math.Vector2;
  angle: number;
  scene: Phaser.Scene;
  bullets: Phaser.Physics.Arcade.Group;
  enemies: Phaser.Physics.Arcade.Group;
  laserGraphics: Phaser.GameObjects.Graphics;
  onHitEnemy: (enemy: Phaser.GameObjects.GameObject, damage: number) => void;
}
