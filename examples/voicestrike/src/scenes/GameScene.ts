import Phaser from 'phaser';
import { Player } from '../entities/Player';
import { Enemy } from '../entities/Enemy';
import { Pistol } from '../weapons/Pistol';
import { Shotgun } from '../weapons/Shotgun';
import { LaserGun } from '../weapons/LaserGun';
import { WaveManager } from '../systems/WaveManager';
import { WalletStore } from '../commerce/WalletStore';
import { WEAPON_CATALOGUE } from '../commerce/ShopCatalogue';
import { CommerceEngine } from '@voice-commerce/core';
import type { WeaponId, FireContext } from '../types/game';
import type { WeaponBase } from '../weapons/WeaponBase';

export class GameScene extends Phaser.Scene {
  // Public so ShopScene can read state without coupling to Phaser internals
  readonly wallet: WalletStore = new WalletStore();
  private commerce!: CommerceEngine;

  private player!: Player;
  private enemies!: Phaser.Physics.Arcade.Group;
  private bullets!: Phaser.Physics.Arcade.Group;
  private laserGraphics!: Phaser.GameObjects.Graphics;
  private waveManager!: WaveManager;
  private weapons!: Map<WeaponId, WeaponBase>;
  private currentWeapon!: WeaponBase;
  private _currentWeaponId: WeaponId = 'pistol';
  private wasdKeys!: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
  };
  private waitingForNextWave = false;
  private gameOverShown = false;
  private readonly playerSpeed = 200;

  constructor() {
    super({ key: 'GameScene' });
  }

  get currentWeaponId(): WeaponId {
    return this._currentWeaponId;
  }

  preload(): void {
    this.generateTextures();
  }

  create(): void {
    this.createArena();

    this.enemies = this.physics.add.group();
    this.bullets = this.physics.add.group();
    this.laserGraphics = this.add.graphics();

    this.player = new Player(this, 400, 500); // start near the southern edge

    this.createWeapons();
    this.createInput();
    this.setupPhysics();
    this.initCommerce();

    this.scene.launch('UIScene');
    this.waveManager = new WaveManager(this, this.enemies);
    this.waveManager.startNextWave();
  }

  update(time: number, _delta: number): void {
    // Freeze game loop while shop is open
    if (this.scene.isActive('ShopScene')) return;

    if (!this.player.isAlive()) {
      this.showGameOver();
      return;
    }

    this.handleMovement();
    this.handleAiming();
    this.laserGraphics.clear();

    if (this.input.activePointer.isDown) {
      this.fireWeapon(time);
    }

    this.updateEnemies();
    this.cleanupBullets();
    this.checkWaveProgress();
  }

  // ─── Public API ───────────────────────────────────────────

  /**
   * Equip a weapon via the CommerceEngine (ownership check included).
   * Phaser-specific weapon switching happens inside the EquipmentAdapter.
   * Fire-and-forget — callers do not need to await.
   */
  equipWeapon(id: WeaponId): void {
    void this.commerce.equip(id).then(result => {
      if (!result.ok) {
        const def = WEAPON_CATALOGUE.find(d => d.id === id);
        this.notify(`${def?.name ?? id} not owned — press B to open shop`, '#ff8844');
      }
    });
  }

  /**
   * Purchase a weapon via the CommerceEngine, then auto-equip on success.
   * Balance deduction and inventory updates happen through WalletStore adapters.
   * Fire-and-forget — callers do not need to await.
   */
  purchaseWeapon(id: WeaponId): void {
    const def = WEAPON_CATALOGUE.find(d => d.id === id);
    void this.commerce.purchase(id).then(result => {
      if (result.ok) {
        this.notify(`${result.item.name} purchased!  -${result.item.price} coins`, '#00ff88');
        this.equipWeapon(id); // auto-equip after successful purchase
      } else if (result.reason === 'already_owned') {
        this.notify(`${def?.name ?? id} already owned`, '#ffff44');
      } else if (result.reason === 'insufficient_funds') {
        this.notify(
          `Not enough coins — need ${def?.price ?? '?'}, have ${this.wallet.balance}`,
          '#ff4444',
        );
      } else if (result.reason === 'item_not_found') {
        this.notify(`Unknown item: ${id}`, '#ff4444');
      }
      // concurrent_request is silently ignored (another purchase is finishing)
    });
  }

  // ─── Private ──────────────────────────────────────────────

  private readonly coinReward = 25;

  private rewardEnemyKill(x: number, y: number): void {
    this.wallet.addCoins(this.coinReward);
    this.events.emit('walletChanged', this.wallet.balance);
    this.showKillBurst(x, y);

    // Floating "+25" at the kill position
    const t = this.add.text(x, y - 10, `+${this.coinReward}`, {
      fontSize: '16px', color: '#ffd700', fontFamily: 'Arial', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(5);

    this.tweens.add({
      targets: t,
      y: y - 55,
      alpha: 0,
      duration: 1100,
      ease: 'Power2',
      onComplete: () => t.destroy(),
    });
  }

  /** Brief white/gold flash at the ship's muzzle point. */
  private showMuzzleFlash(x: number, y: number): void {
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(0, 0, 9);
    g.fillStyle(0xffff88, 0.8);
    g.fillCircle(0, 0, 5);
    g.setPosition(x, y).setDepth(6);
    this.tweens.add({
      targets: g,
      alpha: 0,
      scaleX: 1.8,
      scaleY: 1.8,
      duration: 80,
      onComplete: () => g.destroy(),
    });
  }

  /** Small orange spark where a bullet struck but didn't kill. */
  private showHitSpark(x: number, y: number): void {
    const g = this.add.graphics();
    g.fillStyle(0xff6600, 1);
    g.fillCircle(0, 0, 5);
    g.setPosition(x, y).setDepth(4);
    this.tweens.add({
      targets: g,
      alpha: 0,
      scaleX: 2.5,
      scaleY: 2.5,
      duration: 120,
      onComplete: () => g.destroy(),
    });
  }

  /** Radial burst of fragments on enemy death. */
  private showKillBurst(x: number, y: number): void {
    const count = 8;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const dist  = Phaser.Math.Between(22, 48);
      const g = this.add.graphics();
      g.fillStyle(i % 2 === 0 ? 0xff4400 : 0xffaa00, 1);
      g.fillCircle(0, 0, Phaser.Math.Between(3, 5));
      g.setPosition(x, y).setDepth(4);
      this.tweens.add({
        targets: g,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: 0,
        scaleX: 0.4,
        scaleY: 0.4,
        duration: Phaser.Math.Between(220, 350),
        ease: 'Power2',
        onComplete: () => g.destroy(),
      });
    }
  }

  private notify(text: string, color: string): void {
    this.events.emit('notification', text, color);
  }

  private generateTextures(): void {
    // Player — cyan arrow pointing right
    const pg = this.make.graphics({} as Phaser.Types.GameObjects.Graphics.Options, false);
    pg.fillStyle(0x00e5ff);
    pg.beginPath();
    pg.moveTo(28, 16);
    pg.lineTo(4, 4);
    pg.lineTo(10, 16);
    pg.lineTo(4, 28);
    pg.closePath();
    pg.fillPath();
    pg.fillStyle(0xff6600);
    pg.fillCircle(10, 16, 4);
    pg.generateTexture('player', 32, 32);
    pg.destroy();

    // Enemy — layered red circles
    const eg = this.make.graphics({} as Phaser.Types.GameObjects.Graphics.Options, false);
    eg.fillStyle(0x661111);
    eg.fillCircle(16, 16, 15);
    eg.fillStyle(0xff3333);
    eg.fillCircle(16, 16, 10);
    eg.fillStyle(0xff8888);
    eg.fillCircle(16, 16, 5);
    eg.generateTexture('enemy', 32, 32);
    eg.destroy();

    // Bullet — yellow circle
    const bg = this.make.graphics({} as Phaser.Types.GameObjects.Graphics.Options, false);
    bg.fillStyle(0xffee00);
    bg.fillCircle(4, 4, 4);
    bg.generateTexture('bullet', 8, 8);
    bg.destroy();

    // Pellet — orange circle
    const sg = this.make.graphics({} as Phaser.Types.GameObjects.Graphics.Options, false);
    sg.fillStyle(0xff8800);
    sg.fillCircle(3, 3, 3);
    sg.generateTexture('pellet', 6, 6);
    sg.destroy();
  }

  private createArena(): void {
    const g = this.add.graphics();
    g.fillStyle(0x080818);
    g.fillRect(0, 0, 800, 600);
    g.lineStyle(1, 0x002244, 0.6);
    for (let x = 0; x <= 800; x += 40) g.lineBetween(x, 0, x, 600);
    for (let y = 0; y <= 600; y += 40) g.lineBetween(0, y, 800, y);
    g.lineStyle(3, 0x00aaff, 0.9);
    g.strokeRect(2, 2, 796, 596);
    g.lineStyle(1, 0x0066ff, 0.4);
    g.strokeRect(8, 8, 784, 584);
  }

  private createWeapons(): void {
    this.weapons = new Map<WeaponId, WeaponBase>([
      ['pistol', new Pistol()],
      ['shotgun', new Shotgun()],
      ['laser', new LaserGun()],
    ]);
    this._currentWeaponId = 'pistol';
    this.currentWeapon = this.weapons.get('pistol')!;
  }

  private createInput(): void {
    const kb = this.input.keyboard!;
    this.wasdKeys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    // Weapon shortcuts — equip only if owned
    kb.on('keydown-ONE',   () => this.equipWeapon('pistol'));
    kb.on('keydown-TWO',   () => this.equipWeapon('shotgun'));
    kb.on('keydown-THREE', () => this.equipWeapon('laser'));
    // Shop toggle
    kb.on('keydown-B', () => {
      if (this.scene.isActive('ShopScene')) {
        this.scene.stop('ShopScene');
      } else {
        this.scene.launch('ShopScene');
      }
    });
  }

  private setupPhysics(): void {
    this.physics.world.setBounds(0, 0, 800, 600);

    this.physics.add.overlap(
      this.bullets,
      this.enemies,
      (b, e) => {
        const bullet = b as unknown as Phaser.Physics.Arcade.Sprite;
        const enemy  = e as unknown as Enemy;
        const { x, y } = bullet; // capture before destroy
        const dmg = (bullet.getData('damage') as number) ?? 0;
        bullet.destroy();
        if (enemy.takeDamage(dmg)) {
          this.rewardEnemyKill(enemy.x, enemy.y);
        } else {
          this.showHitSpark(x, y);
        }
      },
    );

    this.physics.add.overlap(
      this.player,
      this.enemies,
      (p, e) => {
        const enemy = e as unknown as Enemy;
        (p as unknown as Player).takeDamage(enemy.damage, this.time.now);
        this.events.emit('healthChanged', this.player.health, this.player.maxHealth);
      },
    );
  }

  private handleMovement(): void {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    let vx = 0;
    let vy = 0;
    if (this.wasdKeys.A.isDown) vx -= this.playerSpeed;
    if (this.wasdKeys.D.isDown) vx += this.playerSpeed;
    if (this.wasdKeys.W.isDown) vy -= this.playerSpeed;
    if (this.wasdKeys.S.isDown) vy += this.playerSpeed;
    if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }
    body.setVelocity(vx, vy);
  }

  private handleAiming(): void {
    const ptr = this.input.activePointer;
    // worldX/Y accounts for any camera transform; ptr.x/y are in CSS canvas pixels.
    const angle = Phaser.Math.Angle.Between(
      this.player.x, this.player.y, ptr.worldX, ptr.worldY,
    );
    this.player.setRotation(angle);
  }

  private fireWeapon(time: number): void {
    const ptr = this.input.activePointer;
    const angle = Phaser.Math.Angle.Between(
      this.player.x, this.player.y, ptr.worldX, ptr.worldY,
    );

    // Offset bullet origin to the ship's nose tip (18 px ahead in aim direction)
    const muzzleX = this.player.x + Math.cos(angle) * 18;
    const muzzleY = this.player.y + Math.sin(angle) * 18;

    const ctx: FireContext = {
      time,
      origin: new Phaser.Math.Vector2(muzzleX, muzzleY),
      angle,
      scene: this,
      bullets: this.bullets,
      enemies: this.enemies,
      laserGraphics: this.laserGraphics,
      onHitEnemy: (enemyObj, damage) => {
        const enemy = enemyObj as unknown as Enemy;
        if (enemy.takeDamage(damage)) {
          this.rewardEnemyKill(enemy.x, enemy.y);
        }
      },
    };

    const prevFired = this.currentWeapon.lastFiredTime;
    this.currentWeapon.fire(ctx);

    // Show muzzle flash only when the weapon actually discharged this frame
    if (this.currentWeapon.lastFiredTime !== prevFired) {
      this.showMuzzleFlash(muzzleX, muzzleY);
    }
  }

  private updateEnemies(): void {
    this.enemies.getChildren().forEach(c => {
      (c as unknown as Enemy).update(this.player.x, this.player.y);
    });
  }

  private cleanupBullets(): void {
    const stale: Phaser.Physics.Arcade.Sprite[] = [];
    this.bullets.getChildren().forEach(c => {
      const b = c as unknown as Phaser.Physics.Arcade.Sprite;
      if (b.x < -60 || b.x > 860 || b.y < -60 || b.y > 660) stale.push(b);
    });
    stale.forEach(b => b.destroy());
  }

  private checkWaveProgress(): void {
    if (!this.waitingForNextWave && this.waveManager.isWaveComplete()) {
      this.waitingForNextWave = true;
      this.time.delayedCall(2000, () => {
        this.waitingForNextWave = false;
        this.waveManager.startNextWave();
      });
    }
  }

  private initCommerce(): void {
    const catalog = WEAPON_CATALOGUE.map(def => ({
      id: def.id,
      name: def.name,
      price: def.price,
      currency: 'coins' as const,
    }));

    this.commerce = new CommerceEngine({
      catalog,
      wallet: {
        getBalance: async () => this.wallet.balance,
        deduct:     async (amount) => { this.wallet.deductCoins(amount); },
        credit:     async (amount) => { this.wallet.addCoins(amount); },
      },
      inventory: {
        owns: async (id) => this.wallet.owns(id as WeaponId),
        add:  async (id) => { this.wallet.addToInventory(id as WeaponId); },
      },
      equipment: {
        equip:       async (id) => { this.switchPhaserWeapon(id as WeaponId); },
        getEquipped: ()         => this._currentWeaponId,
      },
    });

    // Bridge SDK events → Phaser scene events (consumed by UIScene / ShopScene)
    this.commerce.on('walletChanged', (balance) => {
      this.events.emit('walletChanged', balance);
    });
    this.commerce.on('purchase', () => {
      this.events.emit('inventoryChanged');
    });
    this.commerce.on('equipped', (item) => {
      this.events.emit('weaponChanged', item.id);
    });
  }

  private switchPhaserWeapon(id: WeaponId): void {
    const w = this.weapons.get(id);
    if (!w) return;
    this._currentWeaponId = id;
    this.currentWeapon = w;
  }

  private showGameOver(): void {
    if (this.gameOverShown) return;
    this.gameOverShown = true;
    this.enemies.getChildren().forEach(c => {
      const body = (c as Phaser.Physics.Arcade.Sprite).body as Phaser.Physics.Arcade.Body | null;
      body?.setVelocity(0, 0);
    });
    this.add.text(400, 260, 'GAME OVER', {
      fontSize: '64px', color: '#ff4444', fontFamily: 'Arial',
    }).setOrigin(0.5).setDepth(10);
    this.add.text(400, 340, 'Refresh to play again', {
      fontSize: '22px', color: '#888888', fontFamily: 'Arial',
    }).setOrigin(0.5).setDepth(10);
  }
}
