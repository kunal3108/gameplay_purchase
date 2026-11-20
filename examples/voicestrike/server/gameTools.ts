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
 * @param channel - Session channel name (injected as template_variables.channel).
 */
export function buildTools(toolBaseUrl: string): LlmTool[] {
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
        timeout_ms: 5000,
      },
    },
  ] as LlmTool[];
}
