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

/**
 * Build the LlmTool array for the agent config.
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
  ] as LlmTool[];
}
