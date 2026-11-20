import { describe, it, expect } from 'vitest';
import {
  buildListWeaponsResponse,
  buildPlayerStatusResponse,
  buildTools,
} from '../gameTools.js';
import type { GameStateSnapshot } from '../sessionStore.js';

const BASE_STATE: GameStateSnapshot = {
  balance: 350,
  ownedWeapons: ['pistol'],
  equippedWeapon: 'pistol',
  health: 80,
  maxHealth: 100,
  wave: 3,
};

describe('buildListWeaponsResponse', () => {
  it('marks owned weapons correctly', () => {
    const result = buildListWeaponsResponse(BASE_STATE) as Record<string, unknown>;
    const weapons = result['weapons'] as Record<string, unknown>[];
    const pistol = weapons.find(w => w['id'] === 'pistol');
    const shotgun = weapons.find(w => w['id'] === 'shotgun');
    expect(pistol?.['owned']).toBe(true);
    expect(shotgun?.['owned']).toBe(false);
  });

  it('marks affordability — can afford shotgun (300), not laser (500)', () => {
    const result = buildListWeaponsResponse(BASE_STATE) as Record<string, unknown>;
    const weapons = result['weapons'] as Record<string, unknown>[];
    expect(weapons.find(w => w['id'] === 'shotgun')?.['canAfford']).toBe(true);
    expect(weapons.find(w => w['id'] === 'laser')?.['canAfford']).toBe(false);
  });

  it('free weapon is always affordable', () => {
    const broke = { ...BASE_STATE, balance: 0 };
    const result = buildListWeaponsResponse(broke) as Record<string, unknown>;
    const weapons = result['weapons'] as Record<string, unknown>[];
    expect(weapons.find(w => w['id'] === 'pistol')?.['canAfford']).toBe(true);
  });

  it('includes player balance', () => {
    const result = buildListWeaponsResponse(BASE_STATE) as Record<string, unknown>;
    expect(result['playerBalance']).toBe(350);
  });

  it('returns all three weapons', () => {
    const result = buildListWeaponsResponse(BASE_STATE) as Record<string, unknown>;
    const weapons = result['weapons'] as unknown[];
    expect(weapons).toHaveLength(3);
  });
});

describe('buildPlayerStatusResponse', () => {
  it('calculates health percent', () => {
    const result = buildPlayerStatusResponse(BASE_STATE) as Record<string, unknown>;
    expect(result['healthPercent']).toBe(80);
  });

  it('returns raw health and maxHealth', () => {
    const result = buildPlayerStatusResponse(BASE_STATE) as Record<string, unknown>;
    expect(result['health']).toBe(80);
    expect(result['maxHealth']).toBe(100);
  });

  it('returns coins and wave', () => {
    const result = buildPlayerStatusResponse(BASE_STATE) as Record<string, unknown>;
    expect(result['coins']).toBe(350);
    expect(result['wave']).toBe(3);
  });

  it('returns equipped weapon', () => {
    const result = buildPlayerStatusResponse(BASE_STATE) as Record<string, unknown>;
    expect(result['equippedWeapon']).toBe('pistol');
  });

  it('rounds health percent correctly', () => {
    const state = { ...BASE_STATE, health: 33, maxHealth: 100 };
    const result = buildPlayerStatusResponse(state) as Record<string, unknown>;
    expect(result['healthPercent']).toBe(33);
  });
});

describe('buildTools', () => {
  it('returns two tools', () => {
    const tools = buildTools('https://example.com');
    expect(tools).toHaveLength(2);
  });

  it('tool names are correct', () => {
    const tools = buildTools('https://example.com');
    expect(tools[0]!.function.name).toBe('list_available_weapons');
    expect(tools[1]!.function.name).toBe('get_player_status');
  });

  it('tool URLs contain the base URL and channel template variable', () => {
    const tools = buildTools('https://my-tunnel.example.com');
    expect(tools[0]!.server.url).toContain('https://my-tunnel.example.com');
    expect(tools[0]!.server.url).toContain('{{template_variables.channel}}');
    expect(tools[1]!.server.url).toContain('{{template_variables.channel}}');
  });

  it('all tools use sync execution mode', () => {
    const tools = buildTools('https://example.com');
    for (const tool of tools) {
      expect(tool.execution?.mode).toBe('sync');
    }
  });

  it('timeout is set within Agora allowed range (1000–100000ms)', () => {
    const tools = buildTools('https://example.com');
    for (const tool of tools) {
      const ms = tool.server.timeout_ms as number;
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(100_000);
    }
  });
});
