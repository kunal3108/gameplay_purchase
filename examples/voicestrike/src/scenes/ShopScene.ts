import Phaser from 'phaser';
import { WEAPON_CATALOGUE } from '../commerce/ShopCatalogue';
import type { WeaponId } from '../types/game';
import type { GameScene as GameSceneType } from './GameScene';

const P = { x: 110, y: 110, w: 580, h: 370 }; // panel bounds

export class ShopScene extends Phaser.Scene {
  private gameScene!: GameSceneType;
  private actionButtons = new Map<WeaponId, Phaser.GameObjects.Text>();

  constructor() {
    super({ key: 'ShopScene' });
  }

  create(): void {
    this.gameScene = this.scene.get('GameScene') as unknown as GameSceneType;

    // Dim overlay
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.6);
    overlay.fillRect(0, 0, 800, 600);

    // Panel
    const panel = this.add.graphics();
    panel.fillStyle(0x080820, 1);
    panel.fillRoundedRect(P.x, P.y, P.w, P.h, 10);
    panel.lineStyle(2, 0x0088cc, 0.9);
    panel.strokeRoundedRect(P.x, P.y, P.w, P.h, 10);

    // Title
    this.add.text(400, P.y + 16, 'ARMORY', {
      fontSize: '26px', color: '#00e5ff', fontFamily: 'Arial', fontStyle: 'bold',
    }).setOrigin(0.5, 0);

    // Live balance in header
    this.add.text(P.x + 20, P.y + 20, `Balance:`, {
      fontSize: '13px', color: '#888888', fontFamily: 'Arial',
    });
    const balanceHeader = this.add.text(P.x + 90, P.y + 20, `${this.gameScene.wallet.balance} coins`, {
      fontSize: '13px', color: '#ffd700', fontFamily: 'Arial', fontStyle: 'bold',
    });

    // Divider
    const divider = this.add.graphics();
    divider.lineStyle(1, 0x003366, 1);
    divider.lineBetween(P.x + 16, P.y + 55, P.x + P.w - 16, P.y + 55);

    // Weapon rows
    WEAPON_CATALOGUE.forEach((def, i) => {
      const ry = P.y + 70 + i * 84;

      // Row background
      const rowBg = this.add.graphics();
      rowBg.fillStyle(0x0d1a2e, 1);
      rowBg.fillRoundedRect(P.x + 14, ry, P.w - 28, 70, 6);

      // Weapon colour icon
      const iconColor = def.id === 'pistol' ? 0x00e5ff : def.id === 'shotgun' ? 0xff8800 : 0xff0044;
      const icon = this.add.graphics();
      icon.fillStyle(iconColor, 1);
      icon.fillRect(P.x + 28, ry + 22, 22, 22);

      // Name + description
      this.add.text(P.x + 64, ry + 10, def.name, {
        fontSize: '17px', color: '#ffffff', fontFamily: 'Arial', fontStyle: 'bold',
      });
      this.add.text(P.x + 64, ry + 36, def.description, {
        fontSize: '13px', color: '#6688aa', fontFamily: 'Arial',
      });

      // Price
      const priceLabel = def.price === 0 ? 'FREE' : `${def.price} coins`;
      this.add.text(P.x + 360, ry + 24, priceLabel, {
        fontSize: '15px', color: '#ffd700', fontFamily: 'Arial',
      }).setOrigin(0.5, 0);

      // Action button (rebuilt on state change)
      this.rebuildButton(def.id, ry);
    });

    // Footer hint
    this.add.text(400, P.y + P.h - 16, 'Press B to close', {
      fontSize: '12px', color: '#334455', fontFamily: 'Arial',
    }).setOrigin(0.5, 1);

    // ✕ close button
    const closeBtn = this.add.text(P.x + P.w - 14, P.y + 14, '✕', {
      fontSize: '20px', color: '#445566', fontFamily: 'Arial',
    }).setOrigin(1, 0).setInteractive({ useHandCursor: true });
    closeBtn.on('pointerover', () => closeBtn.setColor('#ffffff'));
    closeBtn.on('pointerout', () => closeBtn.setColor('#445566'));
    closeBtn.on('pointerdown', () => this.close());

    // React to wallet/inventory changes (e.g. after purchase)
    this.gameScene.events.on('walletChanged', (balance: number) => {
      balanceHeader.setText(`${balance} coins`);
      this.refreshButtons();
    }, this);
    this.gameScene.events.on('inventoryChanged', () => {
      this.refreshButtons();
    }, this);
    this.gameScene.events.on('weaponChanged', () => {
      this.refreshButtons();
    }, this);
  }

  private rebuildButton(id: WeaponId, rowY: number): void {
    const old = this.actionButtons.get(id);
    if (old?.active) old.destroy();

    const def = WEAPON_CATALOGUE.find(d => d.id === id)!;
    const owned = this.gameScene.wallet.owns(id);
    const equipped = this.gameScene.currentWeaponId === id;
    const canAfford = this.gameScene.wallet.balance >= def.price;

    let label: string;
    let fg: string;
    let bg: string;
    let clickable = false;

    if (equipped) {
      label = 'EQUIPPED'; fg = '#00e5ff'; bg = '#001a2a';
    } else if (owned) {
      label = 'EQUIP'; fg = '#00ff88'; bg = '#002a1a'; clickable = true;
    } else if (canAfford) {
      label = `BUY  ${def.price}¢`; fg = '#ffffff'; bg = '#1a2800'; clickable = true;
    } else {
      label = `BUY  ${def.price}¢`; fg = '#445566'; bg = '#111118';
    }

    const btn = this.add.text(P.x + P.w - 28, rowY + 22, label, {
      fontSize: '13px', color: fg, fontFamily: 'Arial', fontStyle: 'bold',
      backgroundColor: bg, padding: { x: 10, y: 6 },
    }).setOrigin(1, 0);

    if (clickable) {
      btn.setInteractive({ useHandCursor: true });
      btn.on('pointerover', () => btn.setAlpha(0.75));
      btn.on('pointerout', () => btn.setAlpha(1));
      btn.on('pointerdown', () => {
        if (owned) {
          this.gameScene.equipWeapon(id);
          // weaponChanged event triggers refreshButtons after async equip resolves
        } else {
          this.gameScene.purchaseWeapon(id);
          // wallet/inventoryChanged events trigger refreshButtons
        }
      });
    }

    this.actionButtons.set(id, btn);
  }

  private refreshButtons(): void {
    WEAPON_CATALOGUE.forEach((def, i) => {
      this.rebuildButton(def.id, P.y + 70 + i * 84);
    });
  }

  private close(): void {
    this.gameScene.events.off('walletChanged', undefined, this);
    this.gameScene.events.off('inventoryChanged', undefined, this);
    this.gameScene.events.off('weaponChanged', undefined, this);
    this.scene.stop();
  }
}
