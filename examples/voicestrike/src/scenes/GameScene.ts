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
  // Public so ShopScene / ShopHUDScene can read state without Phaser internals coupling.
  // Initialized in create() so it resets on scene.restart().
  wallet!: WalletStore;
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
  private enterKey!: Phaser.Input.Keyboard.Key;
  private jKey!: Phaser.Input.Keyboard.Key;
  private kKey!: Phaser.Input.Keyboard.Key;
  private waitingForNextWave = false;
  private gameOverShown = false;
  private _paused = false;
  private pauseOverlay: Phaser.GameObjects.Text | null = null;
  private _enemyThresholdReached = false;
  private readonly playerSpeed = 200;

  // Unified aim angle — shared by handleAiming() and fireWeapon()
  private aimAngle = 0;
  private keyboardAimActive = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private readonly AIM_ROTATION_SPEED = 2.5; // radians per second

  constructor() {
    super({ key: 'GameScene' });
  }

  get currentWeaponId(): WeaponId {
    return this._currentWeaponId;
  }

  get playerHealth(): number {
    return this.player ? this.player.health : 0;
  }

  get playerMaxHealth(): number {
    return this.player ? this.player.maxHealth : 100;
  }

  get currentWave(): number {
    return this.waveManager ? this.waveManager.currentWave : 0;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  get enemyCount(): number {
    return this.enemies ? this.enemies.getLength() : 0;
  }

  preload(): void {
    this.generateTextures();
  }

  create(): void {
    // Reset all game state — called on initial start AND on scene.restart()
    this.wallet = new WalletStore();
    this._paused = false;
    this.gameOverShown = false;
    this.waitingForNextWave = false;
    this.pauseOverlay = null;
    this._enemyThresholdReached = false;
    this.aimAngle = 0;
    this.keyboardAimActive = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    this.createArena();

    this.enemies = this.physics.add.group();
    this.bullets = this.physics.add.group();
    this.laserGraphics = this.add.graphics();

    this.player = new Player(this, 400, 500); // start near the southern edge

    this.createWeapons();
    this.createInput();
    this.setupPhysics();
    this.initCommerce();

    if (!this.scene.isActive('UIScene')) this.scene.launch('UIScene');
    if (!this.scene.isActive('ShopHUDScene')) this.scene.launch('ShopHUDScene');
    this.waveManager = new WaveManager(this, this.enemies);
    // 8-second grace period: gives the player time to hear Jarvis's greeting
    // before the first enemies spawn. Restart restores this delay automatically
    // because create() runs fresh on every scene.start().
    this.waveManager.scheduleFirstWave(8_000);

    // Signal to main.ts that this scene is fully created and ready for event wiring.
    // Using delayedCall(1) defers to the next game step — safely after create() returns.
    this.time.delayedCall(1, () => { this.events.emit('sceneReady'); });
  }

  update(time: number, delta: number): void {
    // Freeze game loop while paused or shop is open
    if (this._paused) return;
    if (this.scene.isActive('ShopScene')) return;

    if (!this.player.isAlive()) {
      this.showGameOver();
      return;
    }

    this.updateAimAngle(delta); // must run before handleAiming + fireWeapon
    this.handleMovement();
    this.handleAiming();
    this.laserGraphics.clear();

    if (this.input.activePointer.isDown || this.enterKey.isDown) {
      this.fireWeapon(time);
    }

    this.updateEnemies();
    this.cleanupBullets();
    this.checkWaveProgress();
    this.checkEnemyThreshold();
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
   * Purchase a weapon via voice command. Returns the verified result so the
   * voice layer can relay it to Agora before Striker speaks.
   * Uses `commandId` as the CommerceEngine idempotency key to survive Agora retries.
   */
  async purchaseWeaponVoice(
    id: WeaponId,
    commandId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const def = WEAPON_CATALOGUE.find(d => d.id === id);
    if (!def) return { ok: false, message: `Unknown weapon: ${id}` };

    const result = await this.commerce.purchase(id, { idempotencyKey: commandId });

    if (result.ok) {
      this.notify(`${result.item.name} purchased! −${def.price} coins`, '#00ff88');
      await this.commerce.equip(id); // auto-equip; non-fatal if it fails
      return { ok: true, message: `${result.item.name} purchased and equipped` };
    }
    if (result.reason === 'already_owned') {
      return { ok: false, message: `${def.name} already owned` };
    }
    if (result.reason === 'insufficient_funds') {
      return {
        ok: false,
        message: `Not enough coins — ${def.name} costs ${def.price}, you have ${this.wallet.balance}`,
      };
    }
    if (result.reason === 'concurrent_request') {
      return { ok: false, message: 'Purchase already in progress, try again shortly' };
    }
    return { ok: false, message: `Purchase failed: ${result.reason}` };
  }

  /**
   * Equip a weapon via voice command. Returns the verified result.
   */
  async equipWeaponVoice(id: WeaponId): Promise<{ ok: boolean; message: string }> {
    const def = WEAPON_CATALOGUE.find(d => d.id === id);
    if (!def) return { ok: false, message: `Unknown weapon: ${id}` };

    const result = await this.commerce.equip(id);

    if (result.ok) {
      return { ok: true, message: `${result.item.name} equipped` };
    }
    if (result.reason === 'not_owned') {
      return { ok: false, message: `${def.name} not owned — purchase it first` };
    }
    return { ok: false, message: `Equip failed: ${result.reason}` };
  }

  // ─── Lifecycle controls ───────────────────────────────────────────────────

  pauseGame(): { ok: boolean; message: string } {
    if (this._paused || this.gameOverShown) {
      return { ok: false, message: this._paused ? 'Game is already paused' : 'Game is over' };
    }
    this._paused = true;
    this.physics.pause();
    this.time.paused = true; // pause wave spawn timers and all scene time events
    this.pauseOverlay = this.add.text(400, 300, 'PAUSED', {
      fontSize: '64px', color: '#00e5ff', fontFamily: 'Arial', fontStyle: 'bold',
      stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10).setAlpha(0);
    this.tweens.add({ targets: this.pauseOverlay, alpha: 1, duration: 250 });
    this.events.emit('gamePaused');
    return { ok: true, message: 'Game paused' };
  }

  resumeGame(): { ok: boolean; message: string } {
    if (!this._paused) {
      return { ok: false, message: 'Game is not paused' };
    }
    this._paused = false;
    this.physics.resume();
    this.time.paused = false; // resume wave spawn timers
    if (this.pauseOverlay) {
      const overlay = this.pauseOverlay;
      this.pauseOverlay = null;
      this.tweens.add({
        targets: overlay, alpha: 0, duration: 200,
        onComplete: () => { if (overlay.active) overlay.destroy(); },
      });
    }
    this.events.emit('gameResumed');
    return { ok: true, message: 'Game resumed' };
  }

  /**
   * Emit gameRestart event — main.ts handles full restart sequence
   * (voice disconnect → scene.restart → reconnect).
   * Returns immediately so the voice tool can acknowledge before restart begins.
   */
  requestRestart(): { ok: boolean; message: string } {
    if (this.gameOverShown) {
      // Allow restart from game-over screen
    }
    this.time.delayedCall(600, () => { this.events.emit('gameRestart'); });
    return { ok: true, message: 'Restarting game…' };
  }

  /**
   * Emit gameStop event — main.ts handles voice disconnect + return to start screen.
   */
  requestStop(): { ok: boolean; message: string } {
    this.time.delayedCall(600, () => { this.events.emit('gameStop'); });
    return { ok: true, message: 'Stopping game…' };
  }

  /**
   * Trigger highlight animations on ShopHUDScene for specific weapons.
   * Called by main.ts when the voice backend sends a 'highlight' SSE notification.
   */
  highlightWeapons(weaponIds: string[], area: 'arsenal' | 'armory'): void {
    this.events.emit('weaponHighlight', weaponIds, area);
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
    // Enter/Return to shoot (fires in current aim direction)
    this.enterKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

    // J/K — cycle equipped weapon through owned inventory
    this.jKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.J);
    this.kKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.K);

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
        const player = p as unknown as Player;
        const enemy = e as unknown as Enemy;
        const prevHealth = player.health;
        player.takeDamage(enemy.damage, this.time.now);
        // Only emit when health actually changed — the invulnerability window means
        // takeDamage() is a no-op for most frames during overlap, but the callback
        // fires every physics step (~60/s). Emitting only on real changes prevents
        // flooding the voice backend with redundant session-state pushes.
        if (player.health !== prevHealth) {
          this.events.emit('healthChanged', this.player.health, this.player.maxHealth);
        }
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
    // aimAngle is kept up-to-date by updateAimAngle() every frame
    this.player.setRotation(this.aimAngle);
  }

  private fireWeapon(time: number): void {
    const angle = this.aimAngle;

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

  /**
   * Update the unified aim angle each frame.
   *
   * Priority (high → low):
   * 1. Mouse moved this frame → switch to mouse mode (compute from pointer)
   * 2. J or K is held → keyboard mode: rotate aimAngle by AIM_ROTATION_SPEED * dt
   * 3. No key held, mouse mode → recompute angle from current pointer position
   *
   * J = anticlockwise (decreasing radians), K = clockwise (increasing radians).
   */
  private updateAimAngle(delta: number): void {
    const ptr = this.input.activePointer;
    const mx = ptr.worldX;
    const my = ptr.worldY;

    // Mouse movement takes priority — exits keyboard mode immediately
    if (mx !== this.lastMouseX || my !== this.lastMouseY) {
      this.lastMouseX = mx;
      this.lastMouseY = my;
      this.keyboardAimActive = false;
    }

    if (this.jKey.isDown || this.kKey.isDown) {
      this.keyboardAimActive = true;
      const rotDelta = this.AIM_ROTATION_SPEED * (delta / 1000);
      if (this.jKey.isDown) this.aimAngle -= rotDelta; // anticlockwise
      if (this.kKey.isDown) this.aimAngle += rotDelta; // clockwise
    } else if (!this.keyboardAimActive) {
      // Mouse mode: derive angle from pointer each frame
      this.aimAngle = Phaser.Math.Angle.Between(
        this.player.x, this.player.y, mx, my,
      );
    }
    // Keyboard mode with no key held: keep current aimAngle until mouse moves
  }

  /**
   * Emit 'enemyThreshold' once when enemy count crosses from <5 to ≥5.
   * Resets when count falls below threshold so it can fire again next wave.
   */
  private checkEnemyThreshold(): void {
    const count = this.enemies.getLength();
    if (count >= 5 && !this._enemyThresholdReached) {
      this._enemyThresholdReached = true;
      this.events.emit('enemyThreshold', count);
    } else if (count < 5) {
      this._enemyThresholdReached = false;
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
    this._paused = true; // freeze update loop
    this.physics.pause();

    this.enemies.getChildren().forEach(c => {
      const body = (c as Phaser.Physics.Arcade.Sprite).body as Phaser.Physics.Arcade.Body | null;
      body?.setVelocity(0, 0);
    });

    this.add.text(400, 240, 'GAME OVER', {
      fontSize: '64px', color: '#ff4444', fontFamily: 'Arial', fontStyle: 'bold',
      stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10);

    // Restart button
    const restartBtn = this.add.text(285, 330, '  RESTART  ', {
      fontSize: '22px', color: '#00e5ff', fontFamily: 'Arial', fontStyle: 'bold',
      backgroundColor: '#001a2e', padding: { x: 14, y: 8 },
      stroke: '#00aaff', strokeThickness: 1,
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    restartBtn.on('pointerover', () => restartBtn.setColor('#ffffff'));
    restartBtn.on('pointerout',  () => restartBtn.setColor('#00e5ff'));
    restartBtn.on('pointerdown', () => { this.events.emit('gameRestart'); });

    // Back to Start button
    const stopBtn = this.add.text(515, 330, '  BACK TO START  ', {
      fontSize: '22px', color: '#ff8800', fontFamily: 'Arial', fontStyle: 'bold',
      backgroundColor: '#1a0a00', padding: { x: 14, y: 8 },
      stroke: '#ff5500', strokeThickness: 1,
    }).setOrigin(0.5).setDepth(10).setInteractive({ useHandCursor: true });
    stopBtn.on('pointerover', () => stopBtn.setColor('#ffffff'));
    stopBtn.on('pointerout',  () => stopBtn.setColor('#ff8800'));
    stopBtn.on('pointerdown', () => { this.events.emit('gameStop'); });

    // Signal voice layer to stop synchronising state — the session is over.
    this.events.emit('gameOver');
  }
}
