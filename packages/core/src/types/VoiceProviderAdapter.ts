export interface VoiceProviderAdapter {
  join(channelName: string): Promise<void>;
  leave(): Promise<void>;
  onSpeechResult(callback: (text: string) => void): void;
}
