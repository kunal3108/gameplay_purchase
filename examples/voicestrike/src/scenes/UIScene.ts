import Phaser from 'phaser';

export class UIScene extends Phaser.Scene {
  private healthBar!: Phaser.GameObjects.Graphics;
  private waveText!: Phaser.GameObjects.Text;
  private weaponText!: Phaser.GameObjects.Text;
  private balanceText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'UIScene' });
  }

  create(): void {
    // ── Health bar ───────────────────────────────────────────
    this.add.text(16, 16, 'HP', { fontSize: '14px', color: '#888888', fontFamily: 'Arial' });

    const healthBg = this.add.graphics();
    healthBg.fillStyle(0x333333);
    healthBg.fillRect(40, 14, 150, 18);

    this.healthBar = this.add.graphics();
    this.updateHealthBar(100, 100);

    // ── Wave (centre top) ────────────────────────────────────
    this.waveText = this.add
      .text(400, 14, 'Wave 1', { fontSize: '20px', color: '#00e5ff', fontFamily: 'Arial' })
      .setOrigin(0.5, 0);

    // ── Weapon + balance (top right) ─────────────────────────
    this.weaponText = this.add
      .text(784, 14, 'Pistol', { fontSize: '16px', color: '#ffff00', fontFamily: 'Arial' })
      .setOrigin(1, 0);

    this.balanceText = this.add
      .text(784, 36, '1,000 coins', { fontSize: '13px', color: '#ffd700', fontFamily: 'Arial' })
      .setOrigin(1, 0);

    // ── Controls hint (bottom centre) ───────────────────────
    this.add.text(400, 589, 'WASD move  •  Mouse aim/fire  •  1/2/3 equip  •  B shop', {
      fontSize: '11px', color: '#334455', fontFamily: 'Arial',
    }).setOrigin(0.5, 1);

    // ── Listen to GameScene events ───────────────────────────
    const gs = this.scene.get('GameScene');

    gs.events.on('healthChanged', (current: number, max: number) => {
      this.updateHealthBar(current, max);
    });

    gs.events.on('waveChanged', (wave: number) => {
      this.waveText.setText(`Wave ${wave}`);
    });

    gs.events.on('weaponChanged', (name: string) => {
      this.weaponText.setText(name);
    });

    gs.events.on('walletChanged', (balance: number) => {
      this.balanceText.setText(`${balance.toLocaleString()} coins`);
    });

    gs.events.on('notification', (text: string, color: string) => {
      this.showNotification(text, color);
    });
  }

  // ─── Private ──────────────────────────────────────────────

  private updateHealthBar(current: number, max: number): void {
    this.healthBar.clear();
    const ratio = Math.max(0, current / max);
    const color = ratio > 0.5 ? 0x00ff44 : ratio > 0.25 ? 0xffaa00 : 0xff2222;
    this.healthBar.fillStyle(color);
    this.healthBar.fillRect(40, 14, Math.round(150 * ratio), 18);
  }

  private showNotification(text: string, color: string): void {
    const t = this.add
      .text(400, 530, text, {
        fontSize: '17px',
        color,
        fontFamily: 'Arial',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(50);

    this.tweens.add({
      targets: t,
      y: 480,
      alpha: 0,
      duration: 2500,
      ease: 'Power2',
      onComplete: () => t.destroy(),
    });
  }
}
