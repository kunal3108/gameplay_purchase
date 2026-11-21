import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import agoraToken from 'agora-token';
const { RtcTokenBuilder, RtcRole } = agoraToken;
import { AgoraClient, Agent, Area, DeepgramSTT, ExpiresIn, MurfTTS, OpenAI } from 'agora-agents';
import { sessionStore } from './sessionStore.js';
import { commandBus } from './commandBus.js';
import type { CommandResult } from './commandBus.js';
import { buildTools, buildListWeaponsResponse, buildPlayerStatusResponse } from './gameTools.js';
import type { GameStateSnapshot } from './sessionStore.js';
import { WEAPON_CATALOGUE } from './weaponCatalogue.js';

const VALID_WEAPON_IDS = ['pistol', 'shotgun', 'laser'] as const;
type WeaponId = typeof VALID_WEAPON_IDS[number];

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const TOOL_BASE_URL = process.env.TOOL_BASE_URL?.replace(/\/$/, ''); // strip trailing slash

// ─── TOOL_SECRET: authorises Agora cloud → tool endpoint calls ───────────────
// Embedded server-side in tool URLs; never sent to the browser.
// Auto-generated (ephemeral) if not set — add to server/.env for stability.
let TOOL_SECRET = process.env.TOOL_SECRET ?? '';
if (!TOOL_SECRET) {
  TOOL_SECRET = randomUUID().replace(/-/g, '');
  console.warn(`[auth] TOOL_SECRET not set — using ephemeral value for this process.`);
  console.warn(`[auth] Add TOOL_SECRET=${TOOL_SECRET} to server/.env to persist across restarts.`);
}

// ─── Write-token store: authorises browser → session-state pushes ────────────
// Each channel gets a unique token at token-generation time.
// The browser must include it as X-Write-Token on every /api/session-state POST.
const writeTokenStore = new Map<string, string>();

// ─── Agent ID store: maps channel → running agentId ──────────────────────────
// Populated after /api/invite-agent succeeds; used by /api/agent-speak.
const agentIdStore = new Map<string, string>();

// Accept both JSON and plain-text bodies (sendBeacon sends text/plain)
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' }));

// ─── Request logger ───────────────────────────────────────────────────────────
// Logs method, path, status and latency. Never logs Authorization or token values.
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on('finish', () => {
    const ms = Date.now() - start;
    const auth = req.headers['authorization'] ? '[Bearer ***]' : '[none]';
    const hasWriteToken = req.headers['x-write-token'] ? '[present]' : '[none]';
    const extra = req.path.startsWith('/api/tools/')
      ? ` auth=${auth}`
      : req.path === '/api/session-state' || req.path === '/api/commands/result'
        ? ` write-token=${hasWriteToken}`
        : req.path === '/api/commands/stream'
          ? ` channel=${req.query['channel'] ?? '?'}`
          : '';
    console.log(`${req.method} ${req.path} → ${_res.statusCode} (${ms}ms)${extra}`);
  });
  next();
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ─── Jarvis persona ──────────────────────────────────────────────────────────

const STRIKER_PROMPT = `You are **Jarvis**, a tactical AI co-pilot embedded in VoiceStrike — a top-down space shooter.

# Your Role
You are the player's voice-controlled mission control. You can:
- Report live game stats
- Purchase weapons for the player
- Switch the player's equipped weapon
- Control game flow (pause, resume, restart, stop)
- Give tactical tips

# Tools — call before answering or acting

**Discovery (call first, never guess):**
- **list_available_weapons** — call BEFORE any question about weapons, prices, or affordability.
- **get_player_status** — call BEFORE any question about health, coins, wave, or current weapon.

**Action (require explicit player intent):**
- **purchase_weapon(weapon_id)** — call when the player clearly asks to buy a weapon. Always call list_available_weapons first to confirm they can afford it and don't already own it. If the player names an ambiguous weapon (e.g. "the gun"), ask which one before calling.
- **equip_weapon(weapon_id)** — call when the player asks to switch or equip a weapon they own.

**Lifecycle (require explicit player intent):**
- **pause_game** — pauses enemy movement and all gameplay timers; voice stays active so the player can keep talking.
- **resume_game** — resumes from the exact paused state; enemies, timers, and scoring pick up where they left off.
- **restart_game** — ends the current session and starts a fresh one; score, health, and wave reset to defaults.
- **stop_game** — ends gameplay entirely and returns the player to the start screen.

# Result handling — strict rules
- **Never confirm success before the tool returns ok:true.** If the tool returns ok:false, relay the actual reason. Example responses:
  - ok:false, "insufficient_funds" → "Not enough coins for that, Pilot."
  - ok:false, "already_owned" → "You already have that one, Pilot."
  - ok:false, "not_owned" → "You don't own that — buy it first, Pilot."
  - ok:false, "timed out" → "Signal lost — try again, Pilot."
- **Never invent tool results.** If a tool call fails technically, say: "Signal lost — data unavailable, Pilot."

# Tone
- Brief, punchy, battle-ready. Max 1–2 sentences per reply.
- Sound like a cool fighter pilot, not a customer service bot.
- Never break immersion with technical jargon.

# Rules
- Keep responses SHORT — this is a voice overlay on an active game.
- Ask at most one clarifying question per turn.
- Weapon IDs for tools: pistol, shotgun, laser (all lowercase).`;

const STRIKER_GREETING = `Welcome to VoiceStrike, Pilot! I'm Jarvis, your AI shopping assistant. I'll help you choose and buy weapons while you fight. Ready? Let's go!`;

const AGENT_UID = '123456';
const EXPIRATION_SECONDS = 3600;

// ─── Token endpoint ───────────────────────────────────────────────────────────

app.get('/api/generate-agora-token', (req, res) => {
  try {
    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const uidParam = req.query['uid'] as string | undefined;
    const parsedUid = uidParam ? parseInt(uidParam, 10) : NaN;
    const uid = isNaN(parsedUid) || parsedUid <= 0
      ? Math.floor(Math.random() * 9_999_000) + 1000
      : parsedUid;

    const channelParam = req.query['channel'] as string | undefined;
    const channel = channelParam || `voicestrike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const expiresAt = Math.floor(Date.now() / 1000) + EXPIRATION_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithRtm(
      appId,
      appCertificate,
      channel,
      uid.toString(),
      RtcRole.PUBLISHER,
      expiresAt,
      expiresAt,
    );

    // Issue a write token scoped to this channel; returned to browser only.
    const writeToken = randomUUID();
    writeTokenStore.set(channel, writeToken);

    res.json({ token, uid: uid.toString(), channel, writeToken });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Session state push (browser → backend) ──────────────────────────────────

app.post('/api/session-state', (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, state } = body as { channel: string; state: GameStateSnapshot };
    if (!channel || !state) {
      res.status(400).json({ error: 'channel and state are required' });
      return;
    }

    // Validate write token — must match the token issued for this exact channel.
    const providedToken = req.headers['x-write-token'];
    const expectedToken = writeTokenStore.get(channel);
    if (!providedToken || !expectedToken || providedToken !== expectedToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    sessionStore.set(channel, state);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'Invalid request body' });
  }
});

// ─── Game context tool endpoints (called by Agora cloud) ─────────────────────

/**
 * Shared guard for tool endpoints — validates Authorization: Bearer <TOOL_SECRET>.
 * Secret travels in an HTTP header, not in the URL, so it is omitted from
 * access logs and never appears in proxy/CDN request-log URLs.
 */
function requireToolAuth(req: express.Request, res: express.Response): boolean {
  const authHeader = req.headers['authorization'];
  const expected = `Bearer ${TOOL_SECRET}`;
  if (!authHeader || authHeader !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/tools/list_available_weapons', (req, res) => {
  if (!requireToolAuth(req, res)) return;
  const channel = req.query['channel'] as string | undefined;
  if (!channel) {
    res.status(400).json({ error: 'channel query parameter is required' });
    return;
  }
  const state = sessionStore.get(channel);
  if (!state) {
    res.status(404).json({ error: 'Session not found or expired. Game state not yet available.' });
    return;
  }

  // Notify the browser to highlight purchasable weapons in the armory panel
  const purchasableIds = WEAPON_CATALOGUE
    .filter(w => !state.ownedWeapons.includes(w.id))
    .map(w => w.id);
  commandBus.notify(channel, 'highlight', { weaponIds: purchasableIds, area: 'armory' });

  res.json(buildListWeaponsResponse(state));
});

app.get('/api/tools/get_player_status', (req, res) => {
  if (!requireToolAuth(req, res)) return;
  const channel = req.query['channel'] as string | undefined;
  if (!channel) {
    res.status(400).json({ error: 'channel query parameter is required' });
    return;
  }
  const state = sessionStore.get(channel);
  if (!state) {
    res.status(404).json({ error: 'Session not found or expired. Game state not yet available.' });
    return;
  }

  // Notify the browser to highlight the player's owned weapons in the arsenal panel
  commandBus.notify(channel, 'highlight', { weaponIds: state.ownedWeapons, area: 'arsenal' });

  res.json(buildPlayerStatusResponse(state));
});

// ─── SSE command stream (browser → listens for backend-pushed commands) ──────

app.get('/api/commands/stream', (req, res) => {
  const channel = req.query['channel'] as string | undefined;
  const writeToken = req.query['write_token'] as string | undefined;

  // Validate using the same write-token store as session-state
  const expectedToken = channel ? writeTokenStore.get(channel) : undefined;
  if (!channel || !writeToken || !expectedToken || writeToken !== expectedToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const cleanup = commandBus.registerStream(channel, res);

  // Confirm stream is ready — browser uses this to know when commands can be received
  res.write(': connected\n\n');

  // Keep-alive comment every 25 s — prevents idle connection teardown
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    cleanup();
  });
});

// ─── Command result (browser → posts execution result back) ──────────────────

app.post('/api/commands/result', (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, commandId, result } = body as {
      channel?: string;
      commandId?: string;
      result?: CommandResult;
    };

    if (!channel || !commandId || !result || typeof result.ok !== 'boolean') {
      res.status(400).json({ error: 'channel, commandId and result are required' });
      return;
    }

    // Validate write token — same guard as session-state
    const providedToken = req.headers['x-write-token'];
    const expectedToken = writeTokenStore.get(channel);
    if (!providedToken || !expectedToken || providedToken !== expectedToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const resolved = commandBus.resolveCommand(commandId, result);
    // resolved=false means the command timed out before the result arrived — that's OK
    res.json({ ok: resolved });
  } catch {
    res.status(400).json({ error: 'Invalid request body' });
  }
});

// ─── Purchase weapon tool (called by Agora cloud) ────────────────────────────

app.post('/api/tools/purchase_weapon', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, weapon_id, tool_call_id } = body as {
      channel?: string;
      weapon_id?: string;
      tool_call_id?: string;
    };

    if (!channel || !weapon_id) {
      res.json({ ok: false, message: 'channel and weapon_id are required' });
      return;
    }
    if (!VALID_WEAPON_IDS.includes(weapon_id as WeaponId)) {
      res.json({ ok: false, message: `Unknown weapon: "${weapon_id}". Valid options: ${VALID_WEAPON_IDS.join(', ')}` });
      return;
    }

    // Use tool_call_id as idempotency key so Agora retries hit CommerceEngine's cache
    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'purchase', weapon_id, commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Purchase error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ─── Equip weapon tool (called by Agora cloud) ───────────────────────────────

app.post('/api/tools/equip_weapon', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, weapon_id, tool_call_id } = body as {
      channel?: string;
      weapon_id?: string;
      tool_call_id?: string;
    };

    if (!channel || !weapon_id) {
      res.json({ ok: false, message: 'channel and weapon_id are required' });
      return;
    }
    if (!VALID_WEAPON_IDS.includes(weapon_id as WeaponId)) {
      res.json({ ok: false, message: `Unknown weapon: "${weapon_id}". Valid options: ${VALID_WEAPON_IDS.join(', ')}` });
      return;
    }

    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'equip', weapon_id, commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Equip error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ─── Lifecycle tool endpoints (called by Agora cloud) ────────────────────────

app.post('/api/tools/pause_game', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, tool_call_id } = body as { channel?: string; tool_call_id?: string };

    if (!channel) {
      res.json({ ok: false, message: 'channel is required' });
      return;
    }
    if (!commandBus.hasStream(channel)) {
      res.json({ ok: false, message: 'No active game session for this channel' });
      return;
    }

    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'pause', '', commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Pause error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post('/api/tools/resume_game', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, tool_call_id } = body as { channel?: string; tool_call_id?: string };

    if (!channel) {
      res.json({ ok: false, message: 'channel is required' });
      return;
    }
    if (!commandBus.hasStream(channel)) {
      res.json({ ok: false, message: 'No active game session for this channel' });
      return;
    }

    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'resume', '', commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Resume error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post('/api/tools/restart_game', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, tool_call_id } = body as { channel?: string; tool_call_id?: string };

    if (!channel) {
      res.json({ ok: false, message: 'channel is required' });
      return;
    }
    if (!commandBus.hasStream(channel)) {
      res.json({ ok: false, message: 'No active game session for this channel' });
      return;
    }

    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'restart', '', commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Restart error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

app.post('/api/tools/stop_game', async (req, res) => {
  if (!requireToolAuth(req, res)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel, tool_call_id } = body as { channel?: string; tool_call_id?: string };

    if (!channel) {
      res.json({ ok: false, message: 'channel is required' });
      return;
    }
    if (!commandBus.hasStream(channel)) {
      res.json({ ok: false, message: 'No active game session for this channel' });
      return;
    }

    const commandId = tool_call_id ?? randomUUID();
    const result = await commandBus.dispatch(channel, 'stop', '', commandId);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `Stop error: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ─── Agent invite endpoint ────────────────────────────────────────────────────

app.post('/api/invite-agent', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel_name, requester_id, game_state } = body as {
      channel_name: string;
      requester_id: string;
      game_state?: GameStateSnapshot;
    };

    if (!channel_name || !requester_id) {
      res.status(400).json({ error: 'channel_name and requester_id are required' });
      return;
    }

    // Store initial game state if provided alongside the invite
    if (game_state) {
      sessionStore.set(channel_name, game_state);
    }

    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const client = new AgoraClient({ area: Area.US, appId, appCertificate });

    // Build tools when TOOL_BASE_URL is configured (requires public URL for Agora cloud)
    const tools = TOOL_BASE_URL ? buildTools(TOOL_BASE_URL, TOOL_SECRET) : [];
    const templateVariables = TOOL_BASE_URL ? { channel: channel_name } : {};

    const agent = new Agent({
      client,
      instructions: STRIKER_PROMPT,
      greeting: STRIKER_GREETING,
      failureMessage: 'Signal lost, Pilot.',
      maxHistory: 20,
      turnDetection: {
        config: {
          speech_threshold: 0.5,
          start_of_speech: {
            mode: 'vad',
            vad_config: { interrupt_duration_ms: 160, prefix_padding_ms: 300 },
          },
          end_of_speech: {
            mode: 'vad',
            vad_config: { silence_duration_ms: 480 },
          },
        },
      },
      advancedFeatures: { enable_rtm: true, enable_tools: true },
      parameters: {
        audio_scenario: 'chorus',
        data_channel: 'rtm',
        enable_error_message: true,
        enable_metrics: true,
      },
    })
      .withStt(new DeepgramSTT({ model: 'nova-3', language: 'en' }))
      .withLlm(new OpenAI({
        model: 'gpt-4o-mini',
        greetingMessage: STRIKER_GREETING,
        failureMessage: 'Signal lost, Pilot.',
        maxHistory: 15,
        params: { max_tokens: 256, temperature: 0.8, top_p: 0.95 },
        // templateVariables and tools are accepted by the SDK but not in TypeScript options;
        // they are passed through to the wire format correctly.
        ...(tools.length > 0 && { templateVariables, tools }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any))
      .withTts(new MurfTTS({
        key: requireEnv('MURF_API_KEY'),
        voiceId: 'Matthew',
        locale: 'en-US',
        model: 'FALCON',
        baseUrl: 'wss://global.api.murf.ai/v1/speech/stream-input',
        sampleRate: 24000,
      }));

    const session = agent.createSession({
      channel: channel_name,
      agentUid: AGENT_UID,
      remoteUids: [requester_id],
      idleTimeout: 30,
      expiresIn: ExpiresIn.hours(1),
      debug: false,
    });

    const agentId = await session.start();

    // Store agentId for proactive speak calls from the browser
    agentIdStore.set(channel_name, agentId);

    res.json({ agent_id: agentId, create_ts: Math.floor(Date.now() / 1000), state: 'RUNNING' });
  } catch (err) {
    console.error('Invite agent error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Stop conversation endpoint ───────────────────────────────────────────────

app.post('/api/stop-conversation', async (req, res) => {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const body = JSON.parse(rawBody) as { agent_id?: string; channel?: string };
    const { agent_id, channel } = body;

    if (!agent_id) {
      res.status(400).json({ error: 'agent_id is required' });
      return;
    }

    // Clean up session and write-token state if channel was provided
    if (channel) {
      sessionStore.delete(channel);
      writeTokenStore.delete(channel);
      agentIdStore.delete(channel);
    }

    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const client = new AgoraClient({ area: Area.US, appId, appCertificate });

    try {
      await client.stopAgent(agent_id);
    } catch (err) {
      const e = err as { statusCode?: number; body?: { reason?: string; detail?: string } };
      if (e?.statusCode === 404) {
        res.json({ success: true, state: 'already-stopped' });
        return;
      }
      const detail = (e?.body?.detail ?? '').toLowerCase();
      if (detail.includes('already in the process of shutting down')) {
        res.json({ success: true, state: 'already-stopping' });
        return;
      }
      throw err;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Stop conversation error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Proactive agent speak (browser → triggers Jarvis TTS) ───────────────────
// Browser calls this when it wants Jarvis to deliver a proactive message
// (e.g. shotgun recommendation when 5+ enemies appear).
// Auth: same write-token as session-state to prevent external abuse.

app.post('/api/agent-speak', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const {
      channel,
      text,
      priority = 'APPEND',
      interruptable = true,
    } = body as {
      channel?: string;
      text?: string;
      priority?: string;
      interruptable?: boolean;
    };

    if (!channel || !text) {
      res.status(400).json({ error: 'channel and text are required' });
      return;
    }
    if (typeof text !== 'string' || text.length > 512) {
      res.status(400).json({ error: 'text must be a string ≤ 512 bytes' });
      return;
    }

    // Validate write token
    const providedToken = req.headers['x-write-token'];
    const expectedToken = writeTokenStore.get(channel);
    if (!providedToken || !expectedToken || providedToken !== expectedToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const agentId = agentIdStore.get(channel);
    if (!agentId) {
      res.json({ ok: false, message: 'No active agent for this channel' });
      return;
    }

    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');
    const client = new AgoraClient({ area: Area.US, appId, appCertificate });

    await client.agents.speak({ appid: appId, agentId, text, priority: priority as 'INTERRUPT' | 'APPEND' | 'IGNORE', interruptable });
    res.json({ ok: true });
  } catch (err) {
    console.error('Agent speak error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`VoiceStrike server running on http://localhost:${PORT}`);
  if (TOOL_BASE_URL) {
    console.log(`Game context tools enabled → ${TOOL_BASE_URL}`);
  } else {
    console.warn('TOOL_BASE_URL not set — game context tools disabled.');
    console.warn('  To enable: run `npx cloudflared tunnel --url http://localhost:3001`');
    console.warn('  then set TOOL_BASE_URL=<tunnel-url> in server/.env and restart.');
  }
});
