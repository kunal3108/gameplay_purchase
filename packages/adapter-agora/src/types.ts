/** UID Agora assigns to the AI agent in the channel. */
export const AGENT_UID = '123456';

/** Voice connection lifecycle states. */
export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'listening'
  | 'speaking'
  | 'error'
  | 'disconnecting';

/** A single transcript line from user or agent. */
export interface TranscriptEntry {
  id: string;
  speaker: 'user' | 'agent';
  text: string;
  isFinal: boolean;
  timestamp: number;
}

/** Config passed to AgoraVoiceAdapter constructor. */
export interface AgoraVoiceConfig {
  /** Base URL of the voice backend (default: http://localhost:3001) */
  serverUrl?: string;
  /** Agora App ID (from Vite env: VITE_AGORA_APP_ID) */
  appId: string;
}

/** Event callbacks for voice adapter consumers. */
export interface AgoraVoiceCallbacks {
  onStateChange?: (state: VoiceState) => void;
  onTranscript?: (entry: TranscriptEntry) => void;
  onError?: (message: string) => void;
  /** Fired when the backend sends a highlight notification for the shop HUD. */
  onHighlight?: (weaponIds: string[], area: 'arsenal' | 'armory') => void;
}

/**
 * Live game state snapshot pushed from the browser to the backend.
 * The backend stores this per-channel so Agora's REST tool calls can read it.
 */
export interface GameStateSnapshot {
  balance: number;
  ownedWeapons: string[];
  equippedWeapon: string;
  health: number;
  maxHealth: number;
  wave: number;
}

/** Actions the backend can send to the browser for execution. */
export type VoiceCommandAction = 'purchase' | 'equip' | 'pause' | 'resume' | 'restart' | 'stop';

/**
 * A command pushed from the backend to the browser via SSE.
 * The `id` matches Agora's tool_call_id, used as a CommerceEngine idempotency key.
 * `weaponId` is present for purchase/equip; absent for lifecycle commands.
 */
export interface VoiceCommand {
  id: string;
  action: VoiceCommandAction;
  weaponId?: string;
}

/** Result sent back from the browser after executing a VoiceCommand. */
export interface VoiceCommandResult {
  ok: boolean;
  message: string;
}
