import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';
import { UIScene } from './scenes/UIScene';
import { ShopScene } from './scenes/ShopScene';
import { AgoraVoiceAdapter } from '@voice-commerce/adapter-agora';
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

new Phaser.Game(config);

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
      onStateChange: (state) => hud.render(state),
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
} else {
  console.info('[VoiceStrike] VITE_AGORA_APP_ID not set — voice overlay disabled.');
}
