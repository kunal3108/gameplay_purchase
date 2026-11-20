import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { UIScene } from './scenes/UIScene';
import { ShopScene } from './scenes/ShopScene';
import { AgoraVoiceAdapter } from '@voice-commerce/adapter-agora';
import type { GameStateSnapshot } from '@voice-commerce/adapter-agora';
import { VoiceHUD } from './voice/VoiceHUD';

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
  scene: [GameScene, UIScene, ShopScene],
};

const game = new Phaser.Game(config);

// ─── Voice overlay (enabled when VITE_AGORA_APP_ID is set) ───────────────────

const appId = import.meta.env['VITE_AGORA_APP_ID'] as string | undefined;

if (appId) {
  const serverUrl =
    (import.meta.env['VITE_VOICE_SERVER_URL'] as string | undefined) ??
    'http://localhost:3001';

  let hud: VoiceHUD;

  const adapter = new AgoraVoiceAdapter(
    { appId, serverUrl },
    {
      onStateChange: (state) => {
        hud.render(state);
        // Push initial snapshot the moment we're connected and have a channel
        if (state === 'connected') {
          pushState();
        }
      },
      onTranscript: (entry) => hud.addTranscript(entry),
      onError: (msg) => hud.showError(msg),
    },
  );

  hud = new VoiceHUD(adapter);

  const container = document.getElementById('game-container');
  if (container) {
    hud.mount(container);
    hud.render('idle');
  }

  // ── Wire game events → state pushes ──────────────────────────────────────
  // Phaser emits 'ready' after the boot sequence completes and the first
  // scene has started. Only then is GameScene accessible via game.scene.
  game.events.once('ready', () => {
    const gs = game.scene.getScene('GameScene') as unknown as GameScene | null;
    if (!gs) return;

    // Push on every significant state change
    gs.events.on('walletChanged', pushState);
    gs.events.on('healthChanged', pushState);
    gs.events.on('waveChanged', pushState);
    gs.events.on('weaponChanged', pushState);
  });

  /** Reads live state from GameScene and pushes it to the backend. */
  function pushState(): void {
    const gs = game.scene.getScene('GameScene') as unknown as GameScene | null;
    if (!gs) return;
    // Don't push when disconnected — there's no channel to key on
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
} else {
  console.info('[VoiceStrike] VITE_AGORA_APP_ID not set — voice overlay disabled.');
}
