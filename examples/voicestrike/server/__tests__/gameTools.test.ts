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

  it('returns eight tools', () => {
    expect(buildTools(BASE, SECRET)).toHaveLength(8);
  });

  it('tool names are correct', () => {
    const tools = buildTools(BASE, SECRET);
    expect(tools[0]!.function.name).toBe('list_available_weapons');
    expect(tools[1]!.function.name).toBe('get_player_status');
    expect(tools[2]!.function.name).toBe('purchase_weapon');
    expect(tools[3]!.function.name).toBe('equip_weapon');
    expect(tools[4]!.function.name).toBe('pause_game');
    expect(tools[5]!.function.name).toBe('resume_game');
    expect(tools[6]!.function.name).toBe('restart_game');
    expect(tools[7]!.function.name).toBe('stop_game');
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

  it('POST tools have correct body with channel, weapon_id and tool_call_id (weapon tools)', () => {
    const tools = buildTools(BASE, SECRET);
    const weaponPostTools = tools.filter(
      t => t.server.method === 'POST' &&
           (t.function.name === 'purchase_weapon' || t.function.name === 'equip_weapon'),
    );
    expect(weaponPostTools).toHaveLength(2);
    for (const t of weaponPostTools) {
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

  // ── Lifecycle tool tests ───────────────────────────────────────────────────

  it('lifecycle tools are POST methods', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.server.method).toBe('POST');
    }
  });

  it('lifecycle tools do NOT have weapon_id in the body', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      const body = tool.server.body as Record<string, string>;
      expect(body['weapon_id']).toBeUndefined();
    }
  });

  it('lifecycle tools DO have tool_call_id and channel in the body', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      const body = tool.server.body as Record<string, string>;
      expect(body['tool_call_id']).toBe('{{tool_call_id}}');
      expect(body['channel']).toBe('{{template_variables.channel}}');
    }
  });

  it('lifecycle tools use Bearer auth', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      expect(tool.server.headers?.['Authorization']).toBe(`Bearer ${SECRET}`);
    }
  });

  it('lifecycle tools use sync execution mode', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      expect(tool.execution?.mode).toBe('sync');
    }
  });

  it('lifecycle tools have timeout within allowed range', () => {
    const lifecycleNames = ['pause_game', 'resume_game', 'restart_game', 'stop_game'];
    const tools = buildTools(BASE, SECRET);
    for (const name of lifecycleNames) {
      const tool = tools.find(t => t.function.name === name)!;
      const ms = tool.server.timeout_ms as number;
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(100_000);
    }
  });
});
