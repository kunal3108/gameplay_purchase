import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import agoraToken from 'agora-token';
const { RtcTokenBuilder, RtcRole } = agoraToken;
import { AgoraClient, Agent, Area, DeepgramSTT, ExpiresIn, MurfTTS, OpenAI } from 'agora-agents';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

// Accept both JSON and plain-text bodies (sendBeacon sends text/plain)
app.use(cors());
app.use(express.json());
app.use(express.text({ type: '*/*' }));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ─── Striker persona ──────────────────────────────────────────────────────────

const STRIKER_PROMPT = `You are **Striker**, a tactical AI co-pilot embedded in VoiceStrike — a top-down space shooter.

# Your Role
You are the player's voice-controlled mission control. You can:
- Comment on the battle as it unfolds
- Give tactical tips (aim, movement, enemy patterns)
- Track coins and suggest when to visit the shop
- Celebrate kills and close calls

# Tone
- Brief, punchy, battle-ready. Max 1–2 sentences per reply.
- Sound like a cool fighter pilot, not a customer service bot.
- Never break immersion with technical jargon about APIs or SDKs.

# Rules
- Keep responses SHORT — this is a voice overlay on an active game.
- Ask at most one question per turn.
- If you don't know something, say "Unknown, Pilot" and move on.`;

const STRIKER_GREETING = `Striker online. Ready to roll, Pilot?`;

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

    res.json({ token, uid: uid.toString(), channel });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Agent invite endpoint ────────────────────────────────────────────────────

app.post('/api/invite-agent', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { channel_name, requester_id } = body as { channel_name: string; requester_id: string };

    if (!channel_name || !requester_id) {
      res.status(400).json({ error: 'channel_name and requester_id are required' });
      return;
    }

    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const client = new AgoraClient({ area: Area.US, appId, appCertificate });

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
      }))
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
    const body = JSON.parse(rawBody) as { agent_id?: string };
    const { agent_id } = body;

    if (!agent_id) {
      res.status(400).json({ error: 'agent_id is required' });
      return;
    }

    const appId = requireEnv('AGORA_APP_ID');
    const appCertificate = requireEnv('AGORA_APP_CERTIFICATE');

    const client = new AgoraClient({ area: Area.US, appId, appCertificate });

    try {
      await client.stopAgent(agent_id);
    } catch (err) {
      // Treat 404 / already-stopping as success
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`VoiceStrike server running on http://localhost:${PORT}`);
});
