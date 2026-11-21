import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { UIScene } from './scenes/UIScene';
import { ShopHUDScene } from './scenes/ShopHUDScene';
import { ShopScene } from './scenes/ShopScene';
import { AgoraVoiceAdapter } from '@voice-commerce/adapter-agora';
import type { GameStateSnapshot, VoiceCommand } from '@voice-commerce/adapter-agora';
import { VoiceHUD } from './voice/VoiceHUD';
import type { WeaponId } from './types/game';

// ─── Phaser game ──────────────────────────────────────────────────────────────
// BootScene is the first (and only auto-started) scene.
// GameScene + others start only after the player clicks START GAME.

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#080818',
  parent: 'game-container',
  physics: {
    default: 'arcade',
    arcade: { debug: false },
  },
  scene: [BootScene, GameScene, UIScene, ShopHUDScene, ShopScene],
};

const game = new Phaser.Game(config);

// ─── Voice overlay (enabled when VITE_AGORA_APP_ID is set) ───────────────────

const appId = import.meta.env['VITE_AGORA_APP_ID'] as string | undefined;

if (appId) {
  const serverUrl =
    (import.meta.env['VITE_VOICE_SERVER_URL'] as string | undefined) ??
    'http://localhost:3001';

  const container = document.getElementById('game-container')!;

  // ── Build adapter ──────────────────────────────────────────────────────────
  let hud: VoiceHUD;

  // ── Recommendation cooldown ────────────────────────────────────────────────
  let lastRecommendTime = 0;
  const RECOMMEND_COOLDOWN_MS = 60_000;
  const ENEMY_THRESHOLD = 5;
  const SHOTGUN_PRICE = 300;

  const adapter = new AgoraVoiceAdapter(
    { appId, serverUrl },
    {
      onStateChange: (state) => {
        hud.render(state);
        if (state === 'connected') pushState();
      },
      onTranscript: (entry) => hud.addTranscript(entry),
      onError:      (msg)   => hud.showError(msg),
      onHighlight:  (weaponIds, area) => {
        const gs = getGameScene();
        gs?.highlightWeapons(weaponIds, area);
      },
    },
  );

  hud = new VoiceHUD(adapter);
  hud.mount(container);
  hud.render('idle');

  // ── Command handler ────────────────────────────────────────────────────────
  adapter.onCommand(async (cmd: VoiceCommand) => {
    const gs = getGameScene();
    if (!gs) return { ok: false, message: 'Game scene not available' };

    switch (cmd.action) {
      case 'purchase':
        return gs.purchaseWeaponVoice(cmd.weaponId as WeaponId, cmd.id);
      case 'equip':
        return gs.equipWeaponVoice(cmd.weaponId as WeaponId);
      case 'pause':
        return gs.pauseGame();
      case 'resume':
        return gs.resumeGame();
      case 'restart':
        // Acknowledge immediately so Jarvis can confirm before restart begins
        gs.requestRestart(); // fires gameRestart event after 600ms
        return { ok: true, message: 'Restarting game…' };
      case 'stop':
        gs.requestStop(); // fires gameStop event after 600ms
        return { ok: true, message: 'Stopping game…' };
      default:
        return { ok: false, message: `Unknown action: ${String(cmd.action)}` };
    }
  });

  // ── Control button callbacks ───────────────────────────────────────────────
  hud.onPause   = () => { getGameScene()?.pauseGame(); };
  hud.onResume  = () => { getGameScene()?.resumeGame(); };
  hud.onRestart = () => void restartGame();
  hud.onStop    = () => void stopGame();
  hud.onRetry   = () => void retryVoice();

  // ── Start screen + instructions panel ─────────────────────────────────────
  const sidebar = document.getElementById('sidebar')!;
  const instructionsPanel = createInstructionsPanel(sidebar);
  const startScreen = createStartScreen(container);
  startScreen.onStart = async () => {
    startScreen.showConnecting();

    // Start game scenes immediately — voice connects in parallel
    game.scene.stop('BootScene');
    game.scene.start('GameScene');

    // Wire events once GameScene's create() emits 'sceneReady'
    const gsRef = game.scene.getScene('GameScene') as unknown as GameScene;
    gsRef.events.once('sceneReady', () => {
      wireGameEvents(gsRef);
    });

    // Connect Jarvis
    try {
      await adapter.connect();
      startScreen.hide();
      instructionsPanel.show();
    } catch {
      startScreen.showError('Connection failed — click to retry');
    }
  };
  startScreen.show();

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getGameScene(): GameScene | null {
    if (!game.scene.isActive('GameScene')) return null;
    return game.scene.getScene('GameScene') as unknown as GameScene;
  }

  /** Push current game state snapshot to the backend session store. */
  function pushState(): void {
    const gs = getGameScene();
    if (!gs) return;
    const adapterState = adapter.getState();
    if (adapterState === 'idle' || adapterState === 'error') return;

    const snapshot: GameStateSnapshot = {
      balance: gs.wallet.balance,
      ownedWeapons: Array.from(gs.wallet.inventory as Iterable<string>),
      equippedWeapon: gs.currentWeaponId,
      health: gs.playerHealth,
      maxHealth: gs.playerMaxHealth,
      wave: gs.currentWave,
    };
    adapter.pushGameState(snapshot);
  }

  /** Wire GameScene events → state pushes and lifecycle handlers. */
  function wireGameEvents(gs: GameScene): void {
    gs.events.on('walletChanged',  pushState);
    gs.events.on('healthChanged',  pushState);
    gs.events.on('waveChanged',    pushState);
    gs.events.on('weaponChanged',  pushState);

    gs.events.once('gameRestart', () => void restartGame());
    gs.events.once('gameStop',    () => void stopGame());
    gs.events.once('gameOver',    () => onGameOver(gs));

    // Proactive shotgun recommendation when ≥5 enemies appear
    gs.events.on('enemyThreshold', (count: number) => {
      const now = Date.now();
      if (now - lastRecommendTime < RECOMMEND_COOLDOWN_MS) return;
      const adapterState = adapter.getState();
      if (adapterState === 'idle' || adapterState === 'error' || adapterState === 'disconnecting') return;

      const ownedWeapons = Array.from(gs.wallet.inventory as Iterable<string>);
      const balance = gs.wallet.balance;

      // Only recommend shotgun if player doesn't own it and can afford it
      if (!ownedWeapons.includes('shotgun') && balance >= SHOTGUN_PRICE) {
        lastRecommendTime = now;
        const text = `Pilot, ${count} hostiles incoming! That Shotgun for ${SHOTGUN_PRICE} coins would shred this wave.`;
        adapter.requestProactiveRecommendation(text);
        gs.highlightWeapons(['shotgun'], 'armory');
      }
    });

    pushState(); // push initial state now that listeners are wired
  }

  function onGameOver(gs: GameScene): void {
    gs.events.off('walletChanged', pushState);
    gs.events.off('healthChanged', pushState);
    gs.events.off('waveChanged',   pushState);
    gs.events.off('weaponChanged', pushState);
    void adapter.disconnect();
  }

  async function retryVoice(): Promise<void> {
    // Re-run the full Agora connection flow from error state.
    // connect() guard allows re-entry when state === 'error'.
    // On success: state goes connecting → connected; onStateChange → pushState().
    // On failure: state goes back to error; HUD shows retry button again.
    try {
      await adapter.connect();
    } catch {
      // onError callback already fires inside connect() — nothing extra needed
    }
  }

  async function restartGame(): Promise<void> {
    lastRecommendTime = 0; // reset so recommendation can fire again after restart
    // Disconnect voice before resetting game state
    await adapter.disconnect();

    // Stop overlay scenes first (GameScene.create() will relaunch them)
    game.scene.stop('ShopScene');
    game.scene.stop('ShopHUDScene');
    game.scene.stop('UIScene');

    // Listen for GameScene to finish its create() cycle
    const gsRef = game.scene.getScene('GameScene') as unknown as GameScene;
    await new Promise<void>(resolve => {
      gsRef.events.once('sceneReady', () => {
        wireGameEvents(gsRef);
        resolve();
      });
      // Phaser SceneManager: stop then start is the restart equivalent
      game.scene.stop('GameScene');
      game.scene.start('GameScene');
    });

    // Reconnect with a fresh Agora session
    await adapter.connect();
  }

  async function stopGame(): Promise<void> {
    lastRecommendTime = 0;
    await adapter.disconnect();

    game.scene.stop('ShopScene');
    game.scene.stop('ShopHUDScene');
    game.scene.stop('UIScene');
    game.scene.stop('GameScene');
    game.scene.start('BootScene');

    instructionsPanel.hide();
    startScreen.show();
    hud.render('idle');
  }
} else {
  // No VITE_AGORA_APP_ID — start game directly without voice
  console.info('[VoiceStrike] VITE_AGORA_APP_ID not set — voice overlay disabled.');
  game.scene.stop('BootScene');
  game.scene.start('GameScene');
}

// ─── Start screen DOM overlay ─────────────────────────────────────────────────

interface StartScreen {
  show(): void;
  hide(): void;
  showConnecting(): void;
  showError(msg: string): void;
  onStart: () => Promise<void>;
}

function createStartScreen(container: HTMLElement): StartScreen {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'absolute',
    inset: '0',
    background: 'rgba(8,8,24,0.95)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '200',
    fontFamily: 'monospace',
    userSelect: 'none',
  });

  // Title
  const title = document.createElement('div');
  Object.assign(title.style, {
    fontSize: '48px', fontWeight: 'bold', color: '#00e5ff',
    letterSpacing: '6px', marginBottom: '8px',
    textShadow: '0 0 20px rgba(0,229,255,0.6)',
  });
  title.textContent = 'VOICESTRIKE';

  // Subtitle
  const sub = document.createElement('div');
  Object.assign(sub.style, {
    fontSize: '13px', color: '#445566', letterSpacing: '2px', marginBottom: '14px',
  });
  sub.textContent = 'VOICE-CONTROLLED SPACE COMBAT';

  // Jarvis badge
  const badge = document.createElement('div');
  Object.assign(badge.style, {
    fontSize: '11px', color: '#005577', letterSpacing: '1px', marginBottom: '36px',
  });
  badge.textContent = '⬡  VOICE AI: JARVIS  ⬡';

  // Start button
  const startBtn = document.createElement('button');
  Object.assign(startBtn.style, {
    fontSize: '20px', fontWeight: 'bold', fontFamily: 'monospace',
    color: '#00e5ff', background: 'transparent',
    border: '2px solid #00e5ff', borderRadius: '4px',
    padding: '14px 48px', cursor: 'pointer', letterSpacing: '3px',
    transition: 'background 0.15s',
  });
  startBtn.textContent = 'START GAME';
  startBtn.addEventListener('mouseover', () => { startBtn.style.background = 'rgba(0,229,255,0.1)'; });
  startBtn.addEventListener('mouseout',  () => { startBtn.style.background = 'transparent'; });

  // Status line
  const statusLine = document.createElement('div');
  Object.assign(statusLine.style, {
    fontSize: '12px', color: '#446688', marginTop: '20px', minHeight: '20px',
  });

  overlay.append(title, sub, badge, startBtn, statusLine);
  container.appendChild(overlay);

  let startCallback: () => Promise<void> = async () => {};
  let busy = false;

  startBtn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    startBtn.disabled = true;
    void startCallback();
  });

  return {
    show() {
      overlay.style.display = 'flex';
      startBtn.disabled = false;
      busy = false;
      statusLine.textContent = '';
    },
    hide() {
      overlay.style.display = 'none';
    },
    showConnecting() {
      statusLine.textContent = '⟳  Connecting voice AI…';
      statusLine.style.color = '#f5a623';
    },
    showError(msg: string) {
      statusLine.textContent = msg;
      statusLine.style.color = '#f44336';
      startBtn.disabled = false;
      busy = false;
    },
    set onStart(fn: () => Promise<void>) {
      startCallback = fn;
    },
    get onStart() { return startCallback; },
  };
}

// ─── Judge Instructions Panel ─────────────────────────────────────────────────

interface InstructionsPanel {
  show(): void;
  hide(): void;
}

function createInstructionsPanel(sidebar: HTMLElement): InstructionsPanel {
  const h = (text: string, color = '#00aaff'): string =>
    `<div style="color:${color};font-size:10px;font-weight:bold;letter-spacing:1px;margin:6px 0 2px">${text}</div>`;
  const row = (text: string): string => `<div>${text}</div>`;

  sidebar.innerHTML = [
    h('CONTROLS', '#00e5ff'),
    row('WASD — move'),
    row('Mouse — aim &amp; fire'),
    row('Click / Enter — shoot'),
    row('J — aim anticlockwise'),
    row('K — aim clockwise'),
    row('1 / 2 / 3 — equip slot'),
    row('B — open shop'),
    h('ASK JARVIS', '#00e5ff'),
    row('"What can I buy?"'),
    row('"Buy the shotgun"'),
    row('"Equip the laser"'),
    row('"How\'s my health?"'),
    row('"Pause the game"'),
    row('"Restart"'),
  ].join('');

  return {
    show() { sidebar.style.display = 'block'; },
    hide() { sidebar.style.display = 'none'; },
  };
}
