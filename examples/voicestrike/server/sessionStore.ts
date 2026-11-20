/** Live game state pushed from the browser client for tool calls. */
export interface GameStateSnapshot {
  balance: number;
  ownedWeapons: string[];
  equippedWeapon: string;
  health: number;
  maxHealth: number;
  wave: number;
}

interface SessionEntry {
  state: GameStateSnapshot;
  expiresAt: number;
}

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * In-memory session store keyed by Agora channel name.
 * Each entry expires automatically after SESSION_TTL_MS.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  set(channel: string, state: GameStateSnapshot): void {
    this.sessions.set(channel, {
      state,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  get(channel: string): GameStateSnapshot | undefined {
    const entry = this.sessions.get(channel);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.sessions.delete(channel);
      return undefined;
    }
    return entry.state;
  }

  delete(channel: string): void {
    this.sessions.delete(channel);
  }

  size(): number {
    return this.sessions.size;
  }
}

export const sessionStore = new SessionStore();
