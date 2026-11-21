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
  const SECRET = 'test-secret-abc123';
  const BASE = 'https://example.com';

  it('returns four tools', () => {
    expect(buildTools(BASE, SECRET)).toHaveLength(4);
  });

  it('tool names are correct', () => {
    const tools = buildTools(BASE, SECRET);
    expect(tools[0]!.function.name).toBe('list_available_weapons');
    expect(tools[1]!.function.name).toBe('get_player_status');
    expect(tools[2]!.function.name).toBe('purchase_weapon');
    expect(tools[3]!.function.name).toBe('equip_weapon');
  });

  it('GET tool URLs contain base URL, channel template, and no secret', () => {
    const tools = buildTools('https://tunnel.example.com', SECRET);
    const getTools = tools.filter(t => t.server.method === 'GET');
    expect(getTools).toHaveLength(2);
    for (const t of getTools) {
      expect(t.server.url).toContain('https://tunnel.example.com');
      expect(t.server.url).toContain('{{template_variables.channel}}');
      expect(t.server.url).not.toContain(SECRET);
    }
  });

  it('POST tools have correct body with channel, weapon_id and tool_call_id', () => {
    const tools = buildTools(BASE, SECRET);
    const postTools = tools.filter(t => t.server.method === 'POST');
    expect(postTools).toHaveLength(2);
    for (const t of postTools) {
      const body = t.server.body as Record<string, string>;
      expect(body['tool_call_id']).toBe('{{tool_call_id}}');
      expect(body['channel']).toBe('{{template_variables.channel}}');
      expect(body['weapon_id']).toBe('{{args.weapon_id}}');
    }
  });

  it('POST tools do not embed secret in body or URL', () => {
    const tools = buildTools(BASE, SECRET);
    for (const t of tools.filter(t => t.server.method === 'POST')) {
      expect(t.server.url).not.toContain(SECRET);
      expect(JSON.stringify(t.server.body)).not.toContain(SECRET);
    }
  });

  it('purchase_weapon has weapon_id as required enum parameter', () => {
    const purchase = buildTools(BASE, SECRET).find(t => t.function.name === 'purchase_weapon')!;
    const props = purchase.function.parameters?.properties as Record<string, unknown>;
    expect(props['weapon_id']).toBeDefined();
    const weaponParam = props['weapon_id'] as Record<string, unknown>;
    expect(weaponParam['enum']).toContain('shotgun');
    expect(purchase.function.parameters?.required).toContain('weapon_id');
  });

  it('equip_weapon has weapon_id as required enum parameter', () => {
    const equip = buildTools(BASE, SECRET).find(t => t.function.name === 'equip_weapon')!;
    const props = equip.function.parameters?.properties as Record<string, unknown>;
    expect((props['weapon_id'] as Record<string, unknown>)['enum']).toContain('laser');
    expect(equip.function.parameters?.required).toContain('weapon_id');
  });

  it('all tools use Authorization: Bearer <secret> header', () => {
    for (const t of buildTools(BASE, SECRET)) {
      expect(t.server.headers?.['Authorization']).toBe(`Bearer ${SECRET}`);
    }
  });

  it('all tools use sync execution mode', () => {
    for (const t of buildTools(BASE, SECRET)) {
      expect(t.execution?.mode).toBe('sync');
    }
  });

  it('all tools have timeout within Agora allowed range (1000–100000ms)', () => {
    for (const t of buildTools(BASE, SECRET)) {
      const ms = t.server.timeout_ms as number;
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(100_000);
    }
  });
});
