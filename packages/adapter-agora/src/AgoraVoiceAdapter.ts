import AgoraRTC, {
  type IAgoraRTCClient,
  type IMicrophoneAudioTrack,
} from 'agora-rtc-sdk-ng';
import AgoraRTM, { type RTMClient } from 'agora-rtm';
import {
  AgoraVoiceAI,
  AgoraVoiceAIEvents,
  TranscriptHelperMode,
  TurnStatus,
} from 'agora-agent-client-toolkit';
import type { VoiceProviderAdapter } from '@voice-commerce/core';
import {
  AGENT_UID,
  type AgoraVoiceCallbacks,
  type AgoraVoiceConfig,
  type GameStateSnapshot,
  type TranscriptEntry,
  type VoiceCommand,
  type VoiceCommandResult,
  type VoiceState,
} from './types.js';

export class AgoraVoiceAdapter implements VoiceProviderAdapter {
  private readonly appId: string;
  private readonly serverUrl: string;

  private callbacks: AgoraVoiceCallbacks = {};
  private speechCallback: ((text: string) => void) | null = null;

  private state: VoiceState = 'idle';

  // RTC
  private rtcClient: IAgoraRTCClient | null = null;
  private micTrack: IMicrophoneAudioTrack | null = null;
  private uid: string | null = null;
  private channel: string | null = null;

  // RTM
  private rtmClient: RTMClient | null = null;

  // Toolkit
  private voiceAI: AgoraVoiceAI | null = null;

  // Agent lifecycle
  private agentId: string | null = null;

  // Mic mute state
  private micMuted = false;

  // Write token for authorised session-state pushes and command-stream auth
  private writeToken: string | null = null;

  // SSE command stream — receives purchase/equip commands from the backend
  private commandStream: EventSource | null = null;
  private commandCallback: ((cmd: VoiceCommand) => Promise<VoiceCommandResult>) | null = null;

  constructor(config: AgoraVoiceConfig, callbacks: AgoraVoiceCallbacks = {}) {
    this.appId = config.appId;
    this.serverUrl = config.serverUrl ?? 'http://localhost:3001';
    this.callbacks = callbacks;

    window.addEventListener('beforeunload', this.handleUnload);
  }

  // ─── VoiceProviderAdapter (compat shim) ───────────────────────────────────

  async join(channelName?: string): Promise<void> {
    await this.connect(channelName);
  }

  async leave(): Promise<void> {
    await this.disconnect();
  }

  onSpeechResult(callback: (text: string) => void): void {
    this.speechCallback = callback;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getState(): VoiceState {
    return this.state;
  }

  /**
   * Register a handler that is called whenever the backend sends a purchase or
   * equip command via the SSE stream. The handler must return a result that is
   * POSTed back so the backend can resolve the Agora tool call.
   * Call this once before invoking `connect()`.
   */
  onCommand(callback: (cmd: VoiceCommand) => Promise<VoiceCommandResult>): void {
    this.commandCallback = callback;
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    this.micMuted = !enabled;
    if (this.micTrack) {
      await this.micTrack.setEnabled(enabled);
    }
  }

  async connect(preferredChannel?: string): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'error') return;
    this.setState('connecting');

    try {
      // 1. Fetch token + channel from backend
      const channelParam = preferredChannel ? `&channel=${encodeURIComponent(preferredChannel)}` : '';
      const tokenRes = await fetch(`${this.serverUrl}/api/generate-agora-token?uid=0${channelParam}`);
      if (!tokenRes.ok) throw new Error(`Token fetch failed: ${tokenRes.status}`);
      const { token, uid, channel, writeToken } = await tokenRes.json() as { token: string; uid: string; channel: string; writeToken?: string };
      this.uid = uid;
      this.channel = channel;
      this.writeToken = writeToken ?? null;

      // 1b. Open command SSE stream so the backend can push purchase/equip commands.
      this.openCommandStream();

      // 2. Create microphone track — catch permission denial
      try {
        this.micTrack = await AgoraRTC.createMicrophoneAudioTrack();
        if (this.micMuted) await this.micTrack.setEnabled(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('permission')) {
          this.callbacks.onError?.('Microphone permission denied. Please allow mic access and retry.');
        } else {
          this.callbacks.onError?.(`Microphone error: ${msg}`);
        }
        this.setState('error');
        return;
      }

      // 3. Create and configure RTC client
      this.rtcClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      AgoraRTC.setLogLevel(4); // suppress verbose logs

      // Auto-play agent audio when it arrives
      this.rtcClient.on('user-published', async (user, mediaType) => {
        if (mediaType === 'audio') {
          await this.rtcClient!.subscribe(user, 'audio');
          user.audioTrack?.play();
        }
      });

      // 4. Join RTC channel
      await this.rtcClient.join(this.appId, channel, token, parseInt(uid, 10) || null);

      // 5. Publish microphone
      await this.rtcClient.publish(this.micTrack);

      // 6. Create and login RTM client (same token covers RTC+RTM)
      this.rtmClient = new AgoraRTM.RTM(this.appId, uid);
      await this.rtmClient.login({ token });
      await this.rtmClient.subscribe(channel);

      // 7. Init AgoraVoiceAI toolkit
      this.voiceAI = await AgoraVoiceAI.init({
        rtcEngine: this.rtcClient as never,
        rtmEngine: this.rtmClient as never,
        renderMode: TranscriptHelperMode.TEXT,
      });

      // Wire transcript events
      this.voiceAI.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items) => {
        for (const item of items) {
          const isAgent = item.uid === AGENT_UID;
          const isFinal = item.status === TurnStatus.END;
          const entry: TranscriptEntry = {
            id: `${item.uid}-${item.turn_id}-${item.stream_id}`,
            speaker: isAgent ? 'agent' : 'user',
            text: item.text,
            isFinal,
            timestamp: item._time,
          };
          this.callbacks.onTranscript?.(entry);
          if (!isAgent && isFinal && this.speechCallback) {
            this.speechCallback(item.text);
          }
        }
      });

      // Wire agent state → voice state
      this.voiceAI.on(AgoraVoiceAIEvents.AGENT_LISTENING_CHANGED, (_, isListening) => {
        if (isListening) this.setState('listening');
      });
      this.voiceAI.on(AgoraVoiceAIEvents.AGENT_SPEAKING_CHANGED, (_, isSpeaking) => {
        if (isSpeaking) this.setState('speaking');
        else if (this.state === 'speaking') this.setState('connected');
      });

      // Subscribe transcript delivery
      this.voiceAI.subscribeMessage(channel);

      this.setState('connected');

      // 8. Start the AI agent (non-fatal — RTC still works if this fails)
      try {
        const inviteRes = await fetch(`${this.serverUrl}/api/invite-agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_name: channel, requester_id: uid }),
        });
        if (inviteRes.ok) {
          const { agent_id } = await inviteRes.json() as { agent_id: string };
          this.agentId = agent_id;
        } else {
          console.warn('[VoiceAdapter] Agent invite failed, continuing without AI:', inviteRes.status);
        }
      } catch (err) {
        console.warn('[VoiceAdapter] Agent invite error (non-fatal):', err);
      }
    } catch (err) {
      console.error('[VoiceAdapter] connect failed:', err);
      this.callbacks.onError?.(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState('error');
      await this.cleanup();
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnecting') return;
    this.setState('disconnecting');
    await this.cleanup();
    this.setState('idle');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private setState(next: VoiceState): void {
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private async cleanup(): Promise<void> {
    // 1. Stop agent
    if (this.agentId) {
      const id = this.agentId;
      this.agentId = null;
      try {
        await fetch(`${this.serverUrl}/api/stop-conversation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: id }),
        });
      } catch { /* best-effort */ }
    }

    // 2. Destroy toolkit
    try {
      const ai = AgoraVoiceAI.getInstance?.() ?? this.voiceAI;
      if (ai) { ai.destroy(); }
    } catch { /* best-effort */ }
    this.voiceAI = null;

    // 3. RTM logout
    if (this.rtmClient) {
      try {
        if (this.channel) await this.rtmClient.unsubscribe(this.channel);
        await this.rtmClient.logout();
      } catch { /* best-effort */ }
      this.rtmClient = null;
    }

    // 4. Close mic track
    if (this.micTrack) {
      try { this.micTrack.close(); } catch { /* best-effort */ }
      this.micTrack = null;
    }

    // 5. Leave RTC
    if (this.rtcClient) {
      try { await this.rtcClient.leave(); } catch { /* best-effort */ }
      this.rtcClient = null;
    }

    // 6. Close command SSE stream
    if (this.commandStream) {
      this.commandStream.close();
      this.commandStream = null;
    }

    this.uid = null;
    this.channel = null;
    this.writeToken = null;
  }

  /**
   * Open an SSE connection to receive purchase/equip commands from the backend.
   * EventSource auto-reconnects on transient failures.
   * Auth is via write_token query param (EventSource doesn't support custom headers).
   */
  private openCommandStream(): void {
    if (!this.channel || !this.writeToken) return;
    const url =
      `${this.serverUrl}/api/commands/stream` +
      `?channel=${encodeURIComponent(this.channel)}` +
      `&write_token=${encodeURIComponent(this.writeToken)}`;

    this.commandStream = new EventSource(url);

    this.commandStream.onmessage = (event: MessageEvent) => {
      if (!this.commandCallback) return;
      let cmd: VoiceCommand;
      try {
        cmd = JSON.parse(event.data as string) as VoiceCommand;
      } catch {
        return; // ignore malformed events
      }
      this.commandCallback(cmd)
        .then(result => this.postCommandResult(cmd.id, result))
        .catch(() => this.postCommandResult(cmd.id, { ok: false, message: 'Command execution error' }));
    };

    this.commandStream.onerror = () => {
      // EventSource handles reconnection automatically; this is just for visibility.
      console.debug('[VoiceAdapter] Command stream reconnecting...');
    };
  }

  /** POST the browser-side result back so the backend can resolve the Agora tool call. */
  private postCommandResult(commandId: string, result: VoiceCommandResult): void {
    if (!this.channel || !this.writeToken) return;
    fetch(`${this.serverUrl}/api/commands/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Write-Token': this.writeToken,
      },
      body: JSON.stringify({ channel: this.channel, commandId, result }),
    }).catch(() => {}); // best-effort
  }

  private readonly handleUnload = (): void => {
    if (this.agentId) {
      navigator.sendBeacon(
        `${this.serverUrl}/api/stop-conversation`,
        JSON.stringify({ agent_id: this.agentId }),
      );
    }
  };

  /**
   * Push a live game state snapshot to the backend session store.
   * The backend uses this to serve Agora's REST tool calls
   * (`list_available_weapons`, `get_player_status`).
   * Fire-and-forget — never throws.
   */
  pushGameState(state: GameStateSnapshot): void {
    if (!this.channel || !this.writeToken) return; // not yet joined or no write token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Write-Token': this.writeToken,
    };
    fetch(`${this.serverUrl}/api/session-state`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel: this.channel, state }),
    }).catch(() => {}); // best-effort, non-fatal
  }

  destroy(): void {
    window.removeEventListener('beforeunload', this.handleUnload);
  }
}
