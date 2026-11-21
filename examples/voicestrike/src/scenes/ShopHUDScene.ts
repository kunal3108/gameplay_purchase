import Phaser from 'phaser';
import { WEAPON_CATALOGUE } from '../commerce/ShopCatalogue';
import type { WeaponId } from '../types/game';
import type { GameScene as GameSceneType } from './GameScene';

// HUD geometry — upper-right quadrant, below wave text
const HX = 582;  // left edge
const HY = 8;    // top edge
const HW = 213;  // width
const HH = 138;  // height
const COL_A = HX + 4;        // arsenal column x
const COL_B = HX + HW / 2;   // armory column x (right half)
const ROW_START = HY + 52;   // first weapon row y
const ROW_H = 26;             // row height

const WEAPON_COLORS: Record<string, number> = {
  pistol:  0x00e5ff,
  shotgun: 0xff8800,
  laser:   0xff0044,
};

export class ShopHUDScene extends Phaser.Scene {
  private gameScene!: GameSceneType;
  private balanceText!: Phaser.GameObjects.Text;
  private dynamicObjects: Phaser.GameObjects.GameObject[] = [];
  // Highlight state: weaponId → { glow, timer }
  private glows = new Map<string, { glow: Phaser.GameObjects.Graphics; timer: ReturnType<typeof setTimeout> }>();

  constructor() {
    super({ key: 'ShopHUDScene' });
  }

  create(): void {
    this.gameScene = this.scene.get('GameScene') as unknown as GameSceneType;

    this.drawPanel();
    this.drawStaticHeaders();
    this.rebuildWeaponRows();

    this.gameScene.events.on('walletChanged', this.onWalletChanged, this);
    this.gameScene.events.on('inventoryChanged', this.rebuildWeaponRows, this);
    this.gameScene.events.on('weaponChanged', this.rebuildWeaponRows, this);
    this.gameScene.events.on('weaponHighlight', this.onWeaponHighlight, this);
    this.gameScene.events.on('gamePaused', this.onGamePaused, this);
    this.gameScene.events.on('gameResumed', this.onGameResumed, this);
  }

  shutdown(): void {
    this.gameScene?.events.off('walletChanged', this.onWalletChanged, this);
    this.gameScene?.events.off('inventoryChanged', this.rebuildWeaponRows, this);
    this.gameScene?.events.off('weaponChanged', this.rebuildWeaponRows, this);
    this.gameScene?.events.off('weaponHighlight', this.onWeaponHighlight, this);
    this.gameScene?.events.off('gamePaused', this.onGamePaused, this);
    this.gameScene?.events.off('gameResumed', this.onGameResumed, this);
    this.clearAllGlows();
  }

  // ─── Event handlers ───────────────────────────────────────────────────────

  private onWalletChanged(balance: number): void {
    this.balanceText.setText(balance.toLocaleString());
  }

  private onGamePaused(): void {
    this.add.text(HX + HW / 2, HY + HH - 10, '⏸ PAUSED', {
      fontSize: '10px', color: '#00e5ff', fontFamily: 'monospace',
    }).setOrigin(0.5, 1).setDepth(20).setName('pauseLabel');
  }

  private onGameResumed(): void {
    const lbl = this.children.getByName('pauseLabel');
    if (lbl) lbl.destroy();
  }

  private onWeaponHighlight(weaponIds: string[], area: 'arsenal' | 'armory'): void {
    // Clear existing glows for this area's weapons
    for (const [id, entry] of this.glows) {
      if (this.getWeaponArea(id) === area) {
        entry.glow.destroy();
        clearTimeout(entry.timer);
        this.glows.delete(id);
      }
    }

    weaponIds.forEach((weaponId, idx) => {
      const rowY = this.getWeaponRowY(weaponId, area);
      if (rowY === null) return;

      const colX = area === 'arsenal' ? COL_A : COL_B;
      const color = WEAPON_COLORS[weaponId] ?? 0xffffff;

      const glow = this.add.graphics().setDepth(15);
      glow.fillStyle(color, 0.35);
      glow.fillRoundedRect(colX - 2, rowY - 2, (HW / 2) - 6, ROW_H - 2, 4);

      this.tweens.add({
        targets: glow,
        alpha: { from: 0.9, to: 0.2 },
        duration: 500,
        yoyo: true,
        repeat: 4,
        onComplete: () => { if (glow.active) glow.destroy(); },
      });

      const timer = setTimeout(() => {
        if (glow.active) glow.destroy();
        this.glows.delete(weaponId);
      }, 5000 + idx * 100);

      this.glows.set(weaponId, { glow, timer });
    });
  }

  // ─── Drawing ──────────────────────────────────────────────────────────────

  private drawPanel(): void {
    const bg = this.add.graphics().setDepth(10);
    bg.fillStyle(0x060614, 0.88);
    bg.fillRoundedRect(HX, HY, HW, HH, 6);
    bg.lineStyle(1, 0x0055aa, 0.9);
    bg.strokeRoundedRect(HX, HY, HW, HH, 6);
  }

  private drawStaticHeaders(): void {
    // Coin icon + balance
    this.add.text(HX + 6, HY + 7, '💰', {
      fontSize: '12px', fontFamily: 'monospace',
    }).setDepth(11);

    this.balanceText = this.add.text(HX + 23, HY + 7, '1,000', {
      fontSize: '13px', color: '#ffd700', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(11);

    this.add.text(HX + 23 + 42, HY + 9, 'coins', {
      fontSize: '10px', color: '#886600', fontFamily: 'monospace',
    }).setDepth(11);

    // Divider
    const div = this.add.graphics().setDepth(11);
    div.lineStyle(1, 0x003366, 1);
    div.lineBetween(HX + 4, HY + 26, HX + HW - 4, HY + 26);

    // Section headers
    this.add.text(COL_A + 2, HY + 32, 'ARSENAL', {
      fontSize: '9px', color: '#00aaff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(11);

    this.add.text(COL_B + 2, HY + 32, 'ARMORY', {
      fontSize: '9px', color: '#ff6600', fontFamily: 'monospace', fontStyle: 'bold',
    }).setDepth(11);

    // Mid-divider
    const vdiv = this.add.graphics().setDepth(11);
    vdiv.lineStyle(1, 0x003366, 0.8);
    vdiv.lineBetween(HX + HW / 2, HY + 28, HX + HW / 2, HY + HH - 4);

    // Update balance from live wallet
    this.balanceText.setText(this.gameScene.wallet.balance.toLocaleString());
  }

  private rebuildWeaponRows(): void {
    // Destroy old dynamic rows
    for (const obj of this.dynamicObjects) {
      if ((obj as Phaser.GameObjects.Text).active) {
        (obj as Phaser.GameObjects.Text).destroy();
      }
    }
    this.dynamicObjects = [];

    const owned = WEAPON_CATALOGUE.filter(w => this.gameScene.wallet.owns(w.id as WeaponId));
    const purchasable = WEAPON_CATALOGUE.filter(w => !this.gameScene.wallet.owns(w.id as WeaponId));
    const balance = this.gameScene.wallet.balance;
    const equipped = this.gameScene.currentWeaponId;

    // Arsenal column
    owned.forEach((def, i) => {
      const ry = ROW_START + i * ROW_H;
      const color = WEAPON_COLORS[def.id] ?? 0xffffff;
      const isEquipped = def.id === equipped;

      const iconBg = this.add.graphics().setDepth(12);
      iconBg.fillStyle(color, isEquipped ? 0.9 : 0.5);
      iconBg.fillRect(COL_A + 2, ry + 2, 10, 10);
      this.dynamicObjects.push(iconBg);

      const nameStyle = isEquipped
        ? { fontSize: '10px', color: '#00e5ff', fontFamily: 'monospace', fontStyle: 'bold' }
        : { fontSize: '10px', color: '#aaaaaa', fontFamily: 'monospace' };

      const nameText = this.add.text(COL_A + 15, ry + 1, def.name, nameStyle).setDepth(12);
      this.dynamicObjects.push(nameText);

      const badge = this.add.text(COL_A + 15, ry + 13, isEquipped ? '★ EQUIPPED' : '  OWNED', {
        fontSize: '8px',
        color: isEquipped ? '#00e5ff' : '#445566',
        fontFamily: 'monospace',
      }).setDepth(12);
      this.dynamicObjects.push(badge);
    });

    // Armory column
    purchasable.forEach((def, i) => {
      const ry = ROW_START + i * ROW_H;
      const color = WEAPON_COLORS[def.id] ?? 0xffffff;
      const canAfford = balance >= def.price;

      const iconBg = this.add.graphics().setDepth(12);
      iconBg.fillStyle(color, canAfford ? 0.7 : 0.25);
      iconBg.fillRect(COL_B + 2, ry + 2, 10, 10);
      this.dynamicObjects.push(iconBg);

      const nameText = this.add.text(COL_B + 15, ry + 1, def.name, {
        fontSize: '10px',
        color: canAfford ? '#ffffff' : '#445566',
        fontFamily: 'monospace',
      }).setDepth(12);
      this.dynamicObjects.push(nameText);

      const priceText = this.add.text(COL_B + 15, ry + 13, `${def.price}¢`, {
        fontSize: '8px',
        color: canAfford ? '#ffd700' : '#443300',
        fontFamily: 'monospace',
      }).setDepth(12);
      this.dynamicObjects.push(priceText);
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Find the Y position of a weapon's row in a given area, or null if not there. */
  private getWeaponRowY(weaponId: string, area: 'arsenal' | 'armory'): number | null {
    const list = area === 'arsenal'
      ? WEAPON_CATALOGUE.filter(w => this.gameScene.wallet.owns(w.id as WeaponId))
      : WEAPON_CATALOGUE.filter(w => !this.gameScene.wallet.owns(w.id as WeaponId));

    const idx = list.findIndex(w => w.id === weaponId);
    return idx >= 0 ? ROW_START + idx * ROW_H : null;
  }

  private getWeaponArea(weaponId: string): 'arsenal' | 'armory' {
    return this.gameScene.wallet.owns(weaponId as WeaponId) ? 'arsenal' : 'armory';
  }

  private clearAllGlows(): void {
    for (const [, entry] of this.glows) {
      if (entry.glow.active) entry.glow.destroy();
      clearTimeout(entry.timer);
    }
    this.glows.clear();
  }
}
