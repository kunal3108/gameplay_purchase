import type { LlmTool } from 'agora-agents';
import { WEAPON_CATALOGUE } from './weaponCatalogue.js';
import type { GameStateSnapshot } from './sessionStore.js';

// ─── Pure response-building functions (testable without HTTP) ─────────────────

export function buildListWeaponsResponse(state: GameStateSnapshot): object {
  return {
    weapons: WEAPON_CATALOGUE.map(def => ({
      id: def.id,
      name: def.name,
      price: def.price,
      owned: state.ownedWeapons.includes(def.id),
      canAfford: def.price === 0 || state.balance >= def.price,
    })),
    playerBalance: state.balance,
  };
}

export function buildPlayerStatusResponse(state: GameStateSnapshot): object {
  return {
    health: state.health,
    maxHealth: state.maxHealth,
    healthPercent: Math.round((state.health / state.maxHealth) * 100),
    coins: state.balance,
    wave: state.wave,
    equippedWeapon: state.equippedWeapon,
  };
}

// ─── Tool definitions sent to Agora at agent-start time ──────────────────────

/** Weapon IDs the agent may reference. Must match the in-game catalogue. */
const WEAPON_IDS = ['pistol', 'shotgun', 'laser'] as const;

const weaponIdParam = {
  type: 'string',
  description: 'The weapon to act on. Must be exactly one of: pistol, shotgun, laser.',
  enum: [...WEAPON_IDS],
} as const;

/**
 * Build the LlmTool array for the agent config.
 * Returns 8 tools: 2 discovery (GET), 2 weapon action (POST), 4 lifecycle (POST).
 * @param toolBaseUrl - Publicly accessible base URL (required for Agora cloud to reach).
 * @param secret - TOOL_SECRET value; sent as a constant Authorization header so it
 *   never appears in access-log URLs or server-side request logs.
 */
export function buildTools(toolBaseUrl: string, secret: string): LlmTool[] {
  // Constant header value — LlmToolServer.headers supports constants and
  // {{template_variables.*}} placeholders. Secret stays out of the URL.
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
  };

  return [
    // ── Read-only discovery tools ────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'list_available_weapons',
        description:
          'Returns every weapon available in the shop with its name, price in coins, ' +
          'whether the player currently owns it, and whether they can afford to buy it. ' +
          'Call this BEFORE answering any question about weapons, prices, or the shop.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'GET',
        url: `${toolBaseUrl}/api/tools/list_available_weapons?channel={{template_variables.channel}}`,
        headers: authHeaders,
        timeout_ms: 5000,
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_player_status',
        description:
          'Returns the player\'s current health (and max health), coin balance, ' +
          'wave number, and currently equipped weapon. ' +
          'Call this BEFORE answering any question about health, coins, wave, or current weapon.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'GET',
        url: `${toolBaseUrl}/api/tools/get_player_status?channel={{template_variables.channel}}`,
        headers: authHeaders,
        timeout_ms: 5000,
      },
    },
    // ── Action tools — backend delivers to browser, waits for verified result ─
    {
      type: 'function',
      function: {
        name: 'purchase_weapon',
        description:
          'Purchase a weapon for the player using their coin balance and automatically equip it. ' +
          'Always call list_available_weapons first to confirm the player can afford it and does not already own it. ' +
          'Only call this when the player explicitly asks to buy a weapon. ' +
          'Returns ok:true with a confirmation message, or ok:false with the actual reason (e.g. insufficient_funds, already_owned). ' +
          'Never claim a purchase succeeded without receiving ok:true from this tool.',
        parameters: {
          type: 'object',
          properties: { weapon_id: weaponIdParam },
          required: ['weapon_id'],
        },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/purchase_weapon`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
          weapon_id: '{{args.weapon_id}}',
        },
        timeout_ms: 5000,
      },
    },
    {
      type: 'function',
      function: {
        name: 'equip_weapon',
        description:
          'Switch the player\'s active weapon during gameplay. ' +
          'The player must already own the weapon (use list_available_weapons to check). ' +
          'Returns ok:true when the weapon is equipped, or ok:false if not owned. ' +
          'Never claim equip succeeded without receiving ok:true from this tool.',
        parameters: {
          type: 'object',
          properties: { weapon_id: weaponIdParam },
          required: ['weapon_id'],
        },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/equip_weapon`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
          weapon_id: '{{args.weapon_id}}',
        },
        timeout_ms: 5000,
      },
    },
    // ── Lifecycle tools — control game state without a weapon argument ────────
    {
      type: 'function',
      function: {
        name: 'pause_game',
        description:
          'Pauses enemy movement and all gameplay timers. The voice assistant stays active ' +
          'so the player can still talk to Jarvis while paused. ' +
          'Returns ok:true when the game is successfully paused.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/pause_game`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
        },
        timeout_ms: 5000,
      },
    },
    {
      type: 'function',
      function: {
        name: 'resume_game',
        description:
          'Resumes gameplay from the exact paused state — enemies, timers, and scoring ' +
          'all pick up where they left off. ' +
          'Returns ok:true when the game is successfully resumed.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/resume_game`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
        },
        timeout_ms: 5000,
      },
    },
    {
      type: 'function',
      function: {
        name: 'restart_game',
        description:
          'Ends the current game session and starts a completely fresh one — ' +
          'score, health, and wave reset to defaults. ' +
          'Returns ok:true when the restart is initiated.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/restart_game`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
        },
        timeout_ms: 5000,
      },
    },
    {
      type: 'function',
      function: {
        name: 'stop_game',
        description:
          'Ends gameplay entirely and returns the player to the start screen. ' +
          'Use this when the player wants to quit or exit the current session. ' +
          'Returns ok:true when the game has stopped.',
        parameters: { type: 'object', properties: {} },
      },
      execution: { mode: 'sync' },
      server: {
        method: 'POST',
        url: `${toolBaseUrl}/api/tools/stop_game`,
        headers: authHeaders,
        body: {
          tool_call_id: '{{tool_call_id}}',
          channel: '{{template_variables.channel}}',
        },
        timeout_ms: 5000,
      },
    },
  ] as LlmTool[];
}
