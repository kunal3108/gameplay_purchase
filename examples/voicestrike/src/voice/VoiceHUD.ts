import type { AgoraVoiceAdapter } from '@voice-commerce/adapter-agora';
import type { VoiceState, TranscriptEntry } from '@voice-commerce/adapter-agora';

const MAX_TRANSCRIPT = 6;

const STATE_DOT: Record<VoiceState, string> = {
  idle: '#555',
  connecting: '#f5a623',
  connected: '#4caf50',
  listening: '#2196f3',
  speaking: '#9c27b0',
  error: '#f44336',
  disconnecting: '#f5a623',
};

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Offline',
  connecting: 'Waiting for Jarvis…',
  connected: 'Connected',
  listening: 'Listening…',
  speaking: 'Speaking…',
  error: 'Voice Unavailable',
  disconnecting: 'Disconnecting…',
};

/** Jarvis chat window + game control buttons. Mounted as a DOM overlay. */
export class VoiceHUD {
  private root!: HTMLDivElement;
  private dot!: HTMLSpanElement;
  private statusLabel!: HTMLSpanElement;
  private muteBtn!: HTMLButtonElement;
  private retryBtn!: HTMLButtonElement;
  private transcriptEl!: HTMLDivElement;
  private errorBanner!: HTMLDivElement;
  private errorBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseBtn!: HTMLButtonElement;
  private resumeBtn!: HTMLButtonElement;
  private restartBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;

  private adapter: AgoraVoiceAdapter;
  private currentState: VoiceState = 'idle';
  private isMuted = false;
  private transcriptEntries: TranscriptEntry[] = [];

  /** Called when user clicks the game control buttons. Set by main.ts. */
  onPause?: () => void;
  onResume?: () => void;
  onRestart?: () => void;
  onStop?: () => void;
  onRetry?: () => void;

  constructor(adapter: AgoraVoiceAdapter) {
    this.adapter = adapter;
  }

  mount(container: HTMLElement): void {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      bottom: '0',
      left: '0',
      width: '290px',
      zIndex: '100',
      fontFamily: 'monospace',
      userSelect: 'none',
      pointerEvents: 'none', // root doesn't eat clicks — children re-enable
    });

    // ── Error banner ──────────────────────────────────────────────────────────
    this.errorBanner = document.createElement('div');
    Object.assign(this.errorBanner.style, {
      display: 'none',
      background: 'rgba(244,67,54,0.92)',
      color: '#fff',
      fontSize: '11px',
      padding: '5px 8px',
      borderRadius: '4px 4px 0 0',
      wordBreak: 'break-word',
      pointerEvents: 'auto',
    });
    this.root.appendChild(this.errorBanner);

    // ── Title bar ──────────────────────────────────────────────────────────────
    const titleBar = document.createElement('div');
    Object.assign(titleBar.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      background: 'rgba(0,0,0,0.90)',
      borderTop: '1px solid #003366',
      padding: '5px 8px',
      pointerEvents: 'auto',
    });

    this.dot = document.createElement('span');
    Object.assign(this.dot.style, {
      width: '9px', height: '9px', borderRadius: '50%',
      background: STATE_DOT.idle, flexShrink: '0', display: 'inline-block',
    });
    titleBar.appendChild(this.dot);

    const jarvisLabel = document.createElement('span');
    Object.assign(jarvisLabel.style, {
      color: '#00e5ff', fontSize: '12px', fontWeight: 'bold', letterSpacing: '1px',
    });
    jarvisLabel.textContent = 'JARVIS';
    titleBar.appendChild(jarvisLabel);

    this.statusLabel = document.createElement('span');
    Object.assign(this.statusLabel.style, {
      color: '#666', fontSize: '10px', flexGrow: '1',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    this.statusLabel.textContent = 'Offline';
    titleBar.appendChild(this.statusLabel);

    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = '🎙';
    Object.assign(this.muteBtn.style, {
      background: 'transparent', border: '1px solid #333', color: '#ccc',
      borderRadius: '3px', padding: '0 5px', cursor: 'pointer', fontSize: '11px',
      display: 'none', pointerEvents: 'auto',
    });
    this.muteBtn.addEventListener('click', () => void this.toggleMute());
    titleBar.appendChild(this.muteBtn);

    this.retryBtn = document.createElement('button');
    this.retryBtn.textContent = '↺ Retry';
    Object.assign(this.retryBtn.style, {
      background: 'rgba(244,67,54,0.18)', border: '1px solid #f44336', color: '#ff6b6b',
      borderRadius: '3px', padding: '0 6px', cursor: 'pointer', fontSize: '10px',
      display: 'none', pointerEvents: 'auto', fontFamily: 'monospace',
    });
    this.retryBtn.addEventListener('mouseover', () => { this.retryBtn.style.background = 'rgba(244,67,54,0.35)'; });
    this.retryBtn.addEventListener('mouseout',  () => { this.retryBtn.style.background = 'rgba(244,67,54,0.18)'; });
    this.retryBtn.addEventListener('click', () => this.onRetry?.());
    titleBar.appendChild(this.retryBtn);

    this.root.appendChild(titleBar);

    // ── Transcript (chat) area ─────────────────────────────────────────────────
    this.transcriptEl = document.createElement('div');
    Object.assign(this.transcriptEl.style, {
      maxHeight: '140px',
      overflowY: 'auto',
      background: 'rgba(4,8,20,0.88)',
      borderTop: '1px solid #001a3a',
      padding: '5px 8px',
      fontSize: '11px',
      lineHeight: '1.55',
      display: 'none',
      pointerEvents: 'auto',
    });
    this.root.appendChild(this.transcriptEl);

    // ── Controls row ──────────────────────────────────────────────────────────
    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '4px',
      background: 'rgba(0,0,0,0.85)',
      borderTop: '1px solid #001a3a',
      padding: '5px 6px',
      pointerEvents: 'auto',
    });

    const btnStyle = (bg: string, hoverBg: string): Partial<CSSStyleDeclaration> => ({
      background: bg,
      border: '1px solid rgba(255,255,255,0.12)',
      color: '#ddd',
      borderRadius: '3px',
      padding: '3px 7px',
      cursor: 'pointer',
      fontSize: '10px',
      flex: '1',
      pointerEvents: 'auto' as 'auto',
    });

    this.pauseBtn  = this.makeCtrlBtn('⏸ Pause',   btnStyle('#0d2a1a', '#0d3d26'), () => this.onPause?.());
    this.resumeBtn = this.makeCtrlBtn('▶ Resume',   btnStyle('#0a1a2a', '#0a2a3a'), () => this.onResume?.());
    this.restartBtn= this.makeCtrlBtn('↺ Restart',  btnStyle('#2a1a00', '#3a2600'), () => this.onRestart?.());
    this.stopBtn   = this.makeCtrlBtn('⏹ Stop',     btnStyle('#2a0a0a', '#3a0d0d'), () => this.onStop?.());

    controls.append(this.pauseBtn, this.resumeBtn, this.restartBtn, this.stopBtn);
    this.root.appendChild(controls);

    container.appendChild(this.root);
  }

  render(state: VoiceState): void {
    this.currentState = state;
    this.dot.style.background = STATE_DOT[state];
    this.statusLabel.textContent = STATE_LABEL[state];

    const isActive = state !== 'idle' && state !== 'error' && state !== 'connecting';
    this.muteBtn.style.display = isActive ? 'inline-block' : 'none';
    this.transcriptEl.style.display = isActive ? 'block' : 'none';
    this.retryBtn.style.display = state === 'error' ? 'inline-block' : 'none';

    if (state === 'error') {
      // Keep error banner visible for the duration of the error state — cancel auto-hide
      if (this.errorBannerTimer) {
        clearTimeout(this.errorBannerTimer);
        this.errorBannerTimer = null;
      }
      this.errorBanner.style.display = 'block';
    } else {
      // Leaving error state (e.g. retry triggered connecting): hide the banner
      if (this.errorBannerTimer) {
        clearTimeout(this.errorBannerTimer);
        this.errorBannerTimer = null;
      }
      this.errorBanner.style.display = 'none';
    }
  }

  addTranscript(entry: TranscriptEntry): void {
    const existing = this.transcriptEntries.findIndex(e => e.id === entry.id);
    if (existing >= 0) {
      this.transcriptEntries[existing] = entry;
    } else {
      this.transcriptEntries.push(entry);
    }
    const finalOnly = this.transcriptEntries.filter(e => e.isFinal);
    if (finalOnly.length > MAX_TRANSCRIPT) {
      const excess = finalOnly.slice(0, finalOnly.length - MAX_TRANSCRIPT);
      this.transcriptEntries = this.transcriptEntries.filter(e => !excess.includes(e));
    }
    this.renderTranscript();
  }

  showError(message: string): void {
    if (this.errorBannerTimer) clearTimeout(this.errorBannerTimer);
    this.errorBanner.textContent = message;
    this.errorBanner.style.display = 'block';
    // Auto-hide after 8 s for transient errors; render('error') cancels this timer
    // so persistent voice errors remain visible until retry succeeds.
    this.errorBannerTimer = setTimeout(() => {
      this.errorBannerTimer = null;
      if (this.currentState !== 'error') {
        this.errorBanner.style.display = 'none';
      }
    }, 8000);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private renderTranscript(): void {
    this.transcriptEl.innerHTML = '';
    for (const entry of this.transcriptEntries) {
      const line = document.createElement('div');
      Object.assign(line.style, {
        color: entry.speaker === 'agent' ? '#7ec8e3' : '#c8e6c9',
        opacity: entry.isFinal ? '1' : '0.55',
        marginBottom: '2px',
      });
      const prefix = entry.speaker === 'agent' ? 'Jarvis: ' : 'You: ';
      line.textContent = prefix + entry.text;
      this.transcriptEl.appendChild(line);
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private async toggleMute(): Promise<void> {
    this.isMuted = !this.isMuted;
    await this.adapter.setMicEnabled(!this.isMuted);
    this.muteBtn.textContent = this.isMuted ? '🔇' : '🎙';
    this.muteBtn.style.borderColor = this.isMuted ? '#f44336' : '#333';
  }

  private makeCtrlBtn(
    label: string,
    style: Partial<CSSStyleDeclaration>,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    Object.assign(btn.style, style);
    btn.addEventListener('click', onClick);
    return btn;
  }
}
