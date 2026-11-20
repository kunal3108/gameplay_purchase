import type { AgoraVoiceAdapter } from '@voice-commerce/adapter-agora';
import type { VoiceState, TranscriptEntry } from '@voice-commerce/adapter-agora';

const MAX_TRANSCRIPT_LINES = 3;

const STATE_COLORS: Record<VoiceState, string> = {
  idle: '#555',
  connecting: '#f5a623',
  connected: '#4caf50',
  listening: '#2196f3',
  speaking: '#9c27b0',
  error: '#f44336',
  disconnecting: '#f5a623',
};

const STATE_LABELS: Record<VoiceState, string> = {
  idle: 'Connect',
  connecting: 'Connecting…',
  connected: 'Connected',
  listening: 'Listening…',
  speaking: 'Speaking…',
  error: 'Retry',
  disconnecting: 'Disconnecting…',
};

export class VoiceHUD {
  private root!: HTMLDivElement;
  private dot!: HTMLSpanElement;
  private statusLabel!: HTMLSpanElement;
  private actionBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private transcriptPanel!: HTMLDivElement;
  private errorBanner!: HTMLDivElement;

  private adapter: AgoraVoiceAdapter;
  private currentState: VoiceState = 'idle';
  private isMuted = false;
  private transcriptEntries: TranscriptEntry[] = [];

  constructor(adapter: AgoraVoiceAdapter) {
    this.adapter = adapter;
  }

  mount(container: HTMLElement): void {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'absolute',
      bottom: '0',
      right: '0',
      width: '240px',
      zIndex: '100',
      fontFamily: 'monospace',
      userSelect: 'none',
    });

    // Error banner
    this.errorBanner = document.createElement('div');
    Object.assign(this.errorBanner.style, {
      display: 'none',
      background: 'rgba(244,67,54,0.9)',
      color: '#fff',
      fontSize: '11px',
      padding: '4px 8px',
      borderRadius: '4px 4px 0 0',
      wordBreak: 'break-word',
    });
    this.root.appendChild(this.errorBanner);

    // Transcript panel
    this.transcriptPanel = document.createElement('div');
    Object.assign(this.transcriptPanel.style, {
      maxHeight: '110px',
      overflowY: 'auto',
      background: 'rgba(0,0,0,0.7)',
      padding: '4px 8px',
      fontSize: '11px',
      lineHeight: '1.5',
      display: 'none',
    });
    this.root.appendChild(this.transcriptPanel);

    // Controls strip
    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      background: 'rgba(0,0,0,0.85)',
      padding: '6px 8px',
      height: '36px',
    });

    // Status dot
    this.dot = document.createElement('span');
    Object.assign(this.dot.style, {
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      background: STATE_COLORS.idle,
      flexShrink: '0',
      display: 'inline-block',
    });
    controls.appendChild(this.dot);

    // Status label
    this.statusLabel = document.createElement('span');
    Object.assign(this.statusLabel.style, {
      color: '#ccc',
      fontSize: '11px',
      flexGrow: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    this.statusLabel.textContent = 'Voice';
    controls.appendChild(this.statusLabel);

    // Mute button (hidden when idle)
    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = '🎙';
    Object.assign(this.muteBtn.style, {
      background: 'transparent',
      border: '1px solid #555',
      color: '#ccc',
      borderRadius: '3px',
      padding: '0 5px',
      cursor: 'pointer',
      fontSize: '12px',
      display: 'none',
    });
    this.muteBtn.addEventListener('click', () => this.toggleMute());
    controls.appendChild(this.muteBtn);

    // Action button
    this.actionBtn = document.createElement('button');
    Object.assign(this.actionBtn.style, {
      background: '#1a73e8',
      border: 'none',
      color: '#fff',
      borderRadius: '3px',
      padding: '0 8px',
      cursor: 'pointer',
      fontSize: '11px',
      height: '24px',
      whiteSpace: 'nowrap',
    });
    this.actionBtn.textContent = 'Connect';
    this.actionBtn.addEventListener('click', () => this.handleAction());
    controls.appendChild(this.actionBtn);

    this.root.appendChild(controls);
    container.appendChild(this.root);
  }

  render(state: VoiceState): void {
    this.currentState = state;
    this.dot.style.background = STATE_COLORS[state];
    this.statusLabel.textContent = STATE_LABELS[state];

    const isActive = state !== 'idle' && state !== 'error' && state !== 'connecting';
    const isIdle = state === 'idle' || state === 'error';
    const isBusy = state === 'connecting' || state === 'disconnecting';

    // Mute button visibility
    this.muteBtn.style.display = isActive ? 'inline-block' : 'none';

    // Action button
    this.actionBtn.disabled = isBusy;
    this.actionBtn.style.opacity = isBusy ? '0.5' : '1';
    this.actionBtn.style.cursor = isBusy ? 'default' : 'pointer';

    if (isIdle) {
      this.actionBtn.textContent = state === 'error' ? 'Retry' : 'Connect';
      this.actionBtn.style.background = '#1a73e8';
    } else if (isBusy) {
      this.actionBtn.textContent = STATE_LABELS[state];
      this.actionBtn.style.background = '#555';
    } else {
      this.actionBtn.textContent = 'Disconnect';
      this.actionBtn.style.background = '#c62828';
    }

    // Show transcript panel only when connected
    this.transcriptPanel.style.display = isActive ? 'block' : 'none';
  }

  addTranscript(entry: TranscriptEntry): void {
    // Update existing entry with same id if present, else append
    const existing = this.transcriptEntries.findIndex(e => e.id === entry.id);
    if (existing >= 0) {
      this.transcriptEntries[existing] = entry;
    } else {
      this.transcriptEntries.push(entry);
    }

    // Keep at most MAX_TRANSCRIPT_LINES final entries
    const finalOnly = this.transcriptEntries.filter(e => e.isFinal);
    if (finalOnly.length > MAX_TRANSCRIPT_LINES) {
      const toRemove = finalOnly.slice(0, finalOnly.length - MAX_TRANSCRIPT_LINES);
      this.transcriptEntries = this.transcriptEntries.filter(
        e => !toRemove.includes(e),
      );
    }

    this.renderTranscript();
  }

  showError(message: string): void {
    this.errorBanner.textContent = message;
    this.errorBanner.style.display = 'block';
    setTimeout(() => {
      this.errorBanner.style.display = 'none';
    }, 8000);
  }

  private renderTranscript(): void {
    this.transcriptPanel.innerHTML = '';
    for (const entry of this.transcriptEntries) {
      const line = document.createElement('div');
      line.style.color = entry.speaker === 'agent' ? '#7ec8e3' : '#c8e6c9';
      line.style.opacity = entry.isFinal ? '1' : '0.6';
      const prefix = entry.speaker === 'agent' ? 'Striker: ' : 'You: ';
      line.textContent = prefix + entry.text;
      this.transcriptPanel.appendChild(line);
    }
    this.transcriptPanel.scrollTop = this.transcriptPanel.scrollHeight;
  }

  private async handleAction(): Promise<void> {
    const state = this.currentState;
    if (state === 'idle' || state === 'error') {
      await this.adapter.connect();
    } else if (state !== 'connecting' && state !== 'disconnecting') {
      await this.adapter.disconnect();
    }
  }

  private async toggleMute(): Promise<void> {
    this.isMuted = !this.isMuted;
    await this.adapter.setMicEnabled(!this.isMuted);
    this.muteBtn.textContent = this.isMuted ? '🔇' : '🎙';
    this.muteBtn.style.borderColor = this.isMuted ? '#f44336' : '#555';
  }
}
