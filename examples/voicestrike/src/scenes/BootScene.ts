import Phaser from 'phaser';

/**
 * BootScene — The initial scene shown before the player clicks START GAME.
 * Renders the arena background grid so the game canvas looks intentional.
 * The DOM start screen overlay sits on top of this.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create(): void {
    const g = this.add.graphics();
    g.fillStyle(0x080818);
    g.fillRect(0, 0, 800, 600);
    g.lineStyle(1, 0x002244, 0.5);
    for (let x = 0; x <= 800; x += 40) g.lineBetween(x, 0, x, 600);
    for (let y = 0; y <= 600; y += 40) g.lineBetween(0, y, 800, y);
    g.lineStyle(2, 0x00aaff, 0.7);
    g.strokeRect(2, 2, 796, 596);
  }
}
