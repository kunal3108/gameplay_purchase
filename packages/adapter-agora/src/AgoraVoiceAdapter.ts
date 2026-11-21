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
import { agentReadyErrorMessage } from './agentReadinessLogic.js';

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

  // Agent audio readiness — resolved when agent publishes into RTC channel
  private _agentPublished = false;
  private _agentPublishedCbs: Array<() => void> = [];
  private _agentReadyTimer: ReturnType<typeof setTimeout> | null = null;

  // One-shot flag: true once the first agent transcript arrives (confirms greeting pipeline)
  private _greetingLogged = false;

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

    // Reset agent-ready tracking for this connection attempt
    this._agentPublished = false;
    this._agentPublishedCbs = [];

    try {
      // 1. Fetch token + channel from backend
      console.log('[VoiceAdapter:connect] Fetching token...');
      const channelParam = preferredChannel ? `&channel=${encodeURIComponent(preferredChannel)}` : '';
      const tokenRes = await fetch(`${this.serverUrl}/api/generate-agora-token?uid=0${channelParam}`);
      if (!tokenRes.ok) throw new Error(`Token fetch failed: ${tokenRes.status}`);
      const { token, uid, channel, writeToken } = await tokenRes.json() as { token: string; uid: string; channel: string; writeToken?: string };
      this.uid = uid;
      this.channel = channel;
      this.writeToken = writeToken ?? null;
      console.log(`[VoiceAdapter:connect] Token received. Channel: ${channel}, UID: ${uid}`);

      // 1b. Open command SSE stream so the backend can push purchase/equip commands.
      this.openCommandStream();

      // 2. Create microphone track — catch permission denial
      console.log('[VoiceAdapter:connect] Creating microphone track...');
      try {
        this.micTrack = await AgoraRTC.createMicrophoneAudioTrack();
        if (this.micMuted) await this.micTrack.setEnabled(false);
        console.log('[VoiceAdapter:connect] Microphone track created ✓');
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
      AgoraRTC.setLogLevel(4); // suppress verbose SDK logs

      // Handle browser autoplay restrictions
      (AgoraRTC as unknown as { onAudioAutoplayFailed?: () => void }).onAudioAutoplayFailed = () => {
        console.warn('[VoiceAdapter:audio] Autoplay blocked — user must click game area to enable audio');
        this.callbacks.onError?.('Click the game area to enable Jarvis audio');
      };

      // Subscribe to agent audio when published, and detect when Jarvis joins
      this.rtcClient.on('user-published', async (user, mediaType) => {
        if (mediaType !== 'audio') return;
        console.log(`[VoiceAdapter:rtc] user-published uid=${String(user.uid)}`);

        await this.rtcClient!.subscribe(user, 'audio');
        const track = user.audioTrack;
        if (track) {
          track.play();
          console.log(`[VoiceAdapter:rtc] Playing audio from uid=${String(user.uid)} ✓`);
        }

        // Detect when Jarvis (agent) joins the RTC channel
        if (String(user.uid) === AGENT_UID) {
          console.log('[VoiceAdapter:connect] Jarvis audio published — agent is in channel ✓');
          this._agentPublished = true;
          const cbs = this._agentPublishedCbs.splice(0);
          cbs.forEach(cb => cb());
        }
      });

      this.rtcClient.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'audio' && String(user.uid) === AGENT_UID) {
          console.log('[VoiceAdapter:rtc] Jarvis audio unpublished');
        }
      });

      // 4. Join RTC channel
      console.log('[VoiceAdapter:connect] Joining RTC channel...');
      await this.rtcClient.join(this.appId, channel, token, parseInt(uid, 10) || null);
      console.log('[VoiceAdapter:connect] Joined RTC ✓');

      // 5. Publish microphone
      await this.rtcClient.publish(this.micTrack);
      console.log('[VoiceAdapter:connect] Published microphone ✓');

      // 6. Create and login RTM client (same token covers RTC+RTM)
      console.log('[VoiceAdapter:connect] Logging into RTM...');
      this.rtmClient = new AgoraRTM.RTM(this.appId, uid);
      await this.rtmClient.login({ token });
      await this.rtmClient.subscribe(channel);
      console.log('[VoiceAdapter:connect] RTM subscribed ✓');

      // 7. Init AgoraVoiceAI toolkit
      console.log('[VoiceAdapter:connect] Initialising AgoraVoiceAI...');
      this.voiceAI = await AgoraVoiceAI.init({
        rtcEngine: this.rtcClient as never,
        rtmEngine: this.rtmClient as never,
        renderMode: TranscriptHelperMode.TEXT,
      });
      console.log('[VoiceAdapter:connect] AgoraVoiceAI ready ✓');

      // Wire transcript events
      this.voiceAI.on(AgoraVoiceAIEvents.TRANSCRIPT_UPDATED, (items) => {
        for (const item of items) {
          const isAgent = item.uid === AGENT_UID;
          const isFinal = item.status === TurnStatus.END;

          // One-shot: confirm greeting arrived via Murf Falcon → RTC → browser
          if (isAgent && !this._greetingLogged) {
            this._greetingLogged = true;
            console.log('[VoiceAdapter:greeting] Jarvis first audio transcript received ✓ (Murf Falcon pipeline confirmed)');
          }

          const entry: TranscriptEntry = {
            id: `${item.uid}-${item.turn_id}-${item.stream_id}`,
            speaker: isAgent ? 'agent' : 'user',
            text: item.text,
            isFinal,
            timestamp: item._time,
          };
          console.log(`[VoiceAdapter:transcript] ${isAgent ? 'Jarvis' : 'Player'}: "${item.text}" (final=${isFinal})`);
          this.callbacks.onTranscript?.(entry);
          if (!isAgent && isFinal && this.speechCallback) {
            this.speechCallback(item.text);
          }
        }
      });

      // Wire agent state → voice state
      this.voiceAI.on(AgoraVoiceAIEvents.AGENT_LISTENING_CHANGED, (_, isListening) => {
        console.log(`[VoiceAdapter:state] Agent listening: ${isListening}`);
        if (isListening) this.setState('listening');
      });
      this.voiceAI.on(AgoraVoiceAIEvents.AGENT_SPEAKING_CHANGED, (_, isSpeaking) => {
        console.log(`[VoiceAdapter:state] Agent speaking: ${isSpeaking}`);
        if (isSpeaking) this.setState('speaking');
        else if (this.state === 'speaking') this.setState('connected');
      });

      // Subscribe transcript delivery
      this.voiceAI.subscribeMessage(channel);

      // 8. Invite the AI agent.
      //    'connected' state is set ONLY after Jarvis publishes audio into the RTC channel.
      //    If the invite fails we transition to 'error' — never to 'connected'.
      console.log('[VoiceAdapter:connect] Inviting Jarvis agent...');
      try {
        const inviteRes = await fetch(`${this.serverUrl}/api/invite-agent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_name: channel, requester_id: uid }),
        });
        if (inviteRes.ok) {
          const { agent_id } = await inviteRes.json() as { agent_id: string };
          this.agentId = agent_id;
          console.log('[VoiceAdapter:connect] Agent invited ✓');
        } else {
          const body = await inviteRes.text().catch(() => '');
          console.error(`[VoiceAdapter:connect] Agent invite failed (${inviteRes.status}): ${body}`);
          // agentId remains null — handled below
        }
      } catch (err) {
        console.error('[VoiceAdapter:connect] Agent invite error:', err instanceof Error ? err.message : String(err));
        // agentId remains null — handled below
      }

      // 9. Decide next state.
      //
      //    Case A — invite failed (agentId null): Jarvis will never publish audio.
      //    Clean up RTC/RTM resources, show error, allow retry via connect().
      //
      //    Case B — invite succeeded: wait for Jarvis to publish audio (user-published event).
      //    15 s fallback: if no audio arrives, treat as timeout error (also allows retry).
      //    Only the user-published callback transitions to 'connected'.
      if (!this.agentId) {
        const msg = agentReadyErrorMessage('error-invite-failed');
        console.warn(`[VoiceAdapter:connect] ${msg}`);
        this.callbacks.onError?.(msg);
        await this.cleanup();
        this.setState('error');
        return; // connect() resolves normally; start screen hides; HUD shows error + retry
      }

      console.log('[VoiceAdapter:connect] Waiting for Jarvis to join RTC channel...');
      this._agentReadyTimer = setTimeout(() => {
        this._agentReadyTimer = null;
        if (this.state === 'connecting') {
          const msg = agentReadyErrorMessage('error-timeout');
          console.warn(`[VoiceAdapter:connect] ${msg}`);
          this.callbacks.onError?.(msg);
          // Fire-and-forget cleanup (stop agent, leave RTC/RTM) then transition to error.
          void this.cleanup().then(() => {
            if (this.state === 'connecting') this.setState('error');
          });
        }
      }, 15_000);

      if (this._agentPublished) {
        // Agent already published before we reached this check (fast Agora cloud)
        clearTimeout(this._agentReadyTimer);
        this._agentReadyTimer = null;
        // Cast away TS control-flow narrowing from the entry guard at line ~109
        if ((this.state as VoiceState) === 'connecting') this.setState('connected');
      } else {
        this._agentPublishedCbs.push(() => {
          if (this._agentReadyTimer) {
            clearTimeout(this._agentReadyTimer);
            this._agentReadyTimer = null;
          }
          if (this.state === 'connecting') this.setState('connected');
        });
      }

    } catch (err) {
      console.error('[VoiceAdapter:connect] Fatal error:', err instanceof Error ? err.message : String(err));
      this.callbacks.onError?.(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState('error');
      await this.cleanup();
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnecting') return;
    console.log(`[VoiceAdapter:disconnect] Disconnecting (was: ${this.state})`);
    this.setState('disconnecting');
    await this.cleanup();
    this.setState('idle');
    console.log('[VoiceAdapter:disconnect] Disconnected ✓');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private setState(next: VoiceState): void {
    const prev = this.state;
    this.state = next;
    console.log(`[VoiceAdapter:state] ${prev} → ${next}`);
    this.callbacks.onStateChange?.(next);
  }

  private async cleanup(): Promise<void> {
    // 1. Stop agent
    if (this.agentId) {
      const id = this.agentId;
      // Capture channel before nulling — stop-conversation uses it to clean up
      // agentSessionStore, writeTokenStore and sessionStore server-side.
      // Without channel, agentSessionStore is never cleaned up and dead sessions
      // remain in the store, causing ErrConflict 500s on subsequent speak calls.
      const ch = this.channel;
      this.agentId = null;
      try {
        await fetch(`${this.serverUrl}/api/stop-conversation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: id, channel: ch }),
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

    // Reset agent-ready and greeting state
    this._agentPublished = false;
    this._agentPublishedCbs = [];
    this._greetingLogged = false;
    if (this._agentReadyTimer) {
      clearTimeout(this._agentReadyTimer);
      this._agentReadyTimer = null;
    }
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

    // Named 'highlight' events — backend fires these when discovery tools are called
    this.commandStream.addEventListener('highlight', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { weaponIds: string[]; area: 'arsenal' | 'armory' };
        this.callbacks.onHighlight?.(data.weaponIds, data.area);
      } catch { /* ignore malformed */ }
    });

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
   * Ask Jarvis to proactively speak a message via the Agora TTS pipeline.
   * Uses APPEND priority so the message is queued after any current turn.
   * Fire-and-forget — never throws.
   */
  requestProactiveRecommendation(text: string): void {
    if (!this.channel || !this.writeToken) return;
    // Only fire when the agent is fully connected and ready to accept speak commands.
    // Allowing 'connecting' would race against the 15 s timeout cleanup window:
    // cleanup() defers setState('error') until after the stop-conversation fetch,
    // so the state remains 'connecting' briefly while the agent is already dead →
    // agent-speak 500 ErrConflict.  'listening' and 'speaking' are sub-states of
    // connected and are always safe.
    if (this.state !== 'connected' && this.state !== 'listening' && this.state !== 'speaking') return;
    fetch(`${this.serverUrl}/api/agent-speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Write-Token': this.writeToken,
      },
      body: JSON.stringify({ channel: this.channel, text, priority: 'APPEND', interruptable: true }),
    }).catch(() => {}); // best-effort
  }

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
