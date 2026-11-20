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
}
