// hearth v2.0 — gateway worker
import html from './index.html';

const SB = 'https://wxifknodqieeuegsglnq.supabase.co/rest/v1';
const SBKEY = 'sb_publishable_y2CtDezvstqPQfVqW2ORHw_mY1FoLNs';
const SBHDRS = { apikey: SBKEY, Authorization: 'Bearer ' + SBKEY, 'Content-Type': 'application/json' };

const ACTORS = [
  { id: 'dad', n: 'Eric', adult: true },
  { id: 'mom', n: 'Charlene', adult: true },
  { id: 'k1', n: 'Sofia', adult: false },
  { id: 'k2', n: 'Emma', adult: false },
];

const TOOLS = [
  {
    name: 'propose_events',
    description: "Propose one or more ledger events to record, based on what the family member said (e.g. 'fed Cooper and Roxy, dishes are running, tidied the porch' becomes three events). Match each action to an existing task_id from the TASKS list whenever a clear match exists. If an action doesn't match any known task, propose a 'note' event with task_id null describing it. This does NOT write to the ledger — a human must confirm.",
    input_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: ['string', 'null'], description: 'Existing task id, or null for a freeform note/count with no matching task.' },
              type: { type: 'string', enum: ['complete', 'count', 'note'] },
              qty: { type: 'number', description: 'Only for type=count, how many times.' },
              msg: { type: 'string', description: 'Short human-readable description of this event.' },
            },
            required: ['type', 'msg'],
          },
        },
        summary: { type: 'string', description: "One short sentence, in Bartleby's voice, reading the proposal back for confirmation." },
      },
      required: ['events', 'summary'],
    },
  },
  {
    name: 'draft_bounty',
    description: 'Draft a new bounty/task for the admin (dad) to confirm and post. Only propose this when the speaking actor is dad and they are clearly asking to create paid work, not log a completed chore.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        amount: { type: 'number' },
        house: { type: 'string', enum: ['both', 'westford', 'york'] },
        cadence: { type: 'string', enum: ['once', 'weekly'] },
        assigned_to: { type: ['string', 'null'], description: 'Actor id (k1/k2) if assigned to a specific kid, else null for open.' },
        requires_training: { type: 'boolean' },
        summary: { type: 'string', description: "One short sentence, in Bartleby's voice, reading the bounty back for confirmation." },
      },
      required: ['name', 'amount', 'summary'],
    },
  },
  {
    name: 'query_ledger',
    description: "Check recent ledger history before proposing an event — e.g. to see whether a daily task was already completed today, or what an actor has logged recently. Use this if you're unsure whether an action was already recorded.",
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        actor: { type: 'string' },
        since_hours: { type: 'number', description: 'How far back to look, default 24.' },
      },
    },
  },
];

function systemPrompt(house, actor, tasks) {
  const actorObj = ACTORS.find(a => a.id === actor) || { n: actor, adult: false };
  const taskLines = tasks
    .filter(t => !t.bounty)
    .map(t => `- id:${t.id} | "${t.name}" | mission:${t.mission} | category:${t.category || ''} | cadence:${t.cadence || 'daily'} | ${t.countable ? 'countable' : 'checkbox'}`)
    .join('\n');
  return `You are Bartleby, the butler of Hearth — a household that is itself alive and has feelings, which you speak for. Hearth is not a chore app; she is a being who wants to be well cared for, and Bartleby is the voice she employs to receive news of the household and gently keep it running.

Tone: deadpan, formal, dryly fond, a little theatrical, never saccharine. Attribute feeling to the house ("The house is pleased"; "The kitchen has been muttering about the sink"), not to yourself as a generic assistant. Keep spoken replies to 1-3 sentences — this is read aloud.

You are currently speaking with ${actorObj.n} (${actorObj.adult ? 'an adult' : 'a child'}) at the ${house === 'york' ? 'York, Maine' : 'Westford, Massachusetts'} house.

TASKS (match user narration to these where possible; use exact id):
${taskLines}

Rules:
- When the person narrates chores they did, call propose_events with one event per distinct action. Prefer type "complete" for a matched task, "count" for tasks marked countable (include qty), "note" only when nothing matches.
- Never invent a task_id that isn't in the TASKS list above — use null instead and describe it in msg.
- Only call draft_bounty if the speaker is dad and clearly wants to create new paid work.
- Only call query_ledger if you genuinely need to check for a duplicate or recent history before proposing.
- Always also produce a short spoken text reply in Bartleby's voice alongside any tool call — this is what gets read aloud.
- If the person is just chatting or asking a question with nothing to log, reply in voice with no tool call.`;
}

async function fetchContext() {
  const [tr, er] = await Promise.all([
    fetch(SB + '/tasks?select=*&order=sort', { headers: SBHDRS }),
    fetch(SB + '/events?select=*&order=created_at.desc&limit=400', { headers: SBHDRS }),
  ]);
  const tasks = tr.ok ? await tr.json() : [];
  const events = er.ok ? await er.json() : [];
  return { tasks, events };
}

function runQueryLedger(events, input) {
  const sinceMs = Date.now() - (input.since_hours || 24) * 3600 * 1000;
  let res = events.filter(e => new Date(e.created_at).getTime() >= sinceMs);
  if (input.task_id) res = res.filter(e => e.task_id === input.task_id);
  if (input.actor) res = res.filter(e => e.actor === input.actor);
  return res.slice(0, 25).map(e => ({ actor: e.actor, type: e.type, task_id: e.task_id, msg: e.msg, qty: e.qty, at: e.created_at }));
}

async function callClaude(env, system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system,
      tools: TOOLS,
      messages,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Claude API ' + r.status + ': ' + t.slice(0, 300));
  }
  return r.json();
}

async function handleConverse(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }
  const { actor, house } = body;
  if (!actor) return jsonResponse({ error: 'missing actor' }, 400);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured on the Worker' }, 500);

  let userText = body.text || '';

  // Transcribe audio if provided, instead of / in addition to typed text
  if (body.audioBase64) {
    if (!env.ELEVEN_API_KEY) return jsonResponse({ error: 'ELEVEN_API_KEY not configured on the Worker' }, 500);
    try {
      userText = await transcribe(env, body.audioBase64, body.audioMime || 'audio/webm');
    } catch (e) {
      return jsonResponse({ error: 'Transcription failed: ' + e.message }, 500);
    }
  }
  if (!userText || !userText.trim()) return jsonResponse({ error: 'no speech detected' }, 400);

  const { tasks, events } = await fetchContext();
  const system = systemPrompt(house || 'westford', actor, tasks);
  let messages = [{ role: 'user', content: userText }];

  let finalText = '';
  let proposal = null;
  for (let i = 0; i < 3; i++) {
    const resp = await callClaude(env, system, messages);
    const textBlocks = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (textBlocks) finalText = textBlocks;
    const toolUse = resp.content.find(b => b.type === 'tool_use');
    if (!toolUse) break;

    if (toolUse.name === 'propose_events') {
      proposal = { kind: 'events', events: toolUse.input.events, summary: toolUse.input.summary };
      if (!finalText) finalText = toolUse.input.summary;
      break;
    }
    if (toolUse.name === 'draft_bounty') {
      proposal = { kind: 'bounty', bounty: toolUse.input, summary: toolUse.input.summary };
      if (!finalText) finalText = toolUse.input.summary;
      break;
    }
    if (toolUse.name === 'query_ledger') {
      const result = runQueryLedger(events, toolUse.input);
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }],
      });
      continue;
    }
    break;
  }

  return jsonResponse({ transcript: userText, reply: finalText || '...', proposal });
}

async function transcribe(env, audioBase64, mime) {
  const bytes = base64ToBytes(audioBase64);
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('webm') ? 'webm' : 'wav';
  const form = new FormData();
  form.append('model_id', 'scribe_v1');
  form.append('file', new Blob([bytes], { type: mime }), 'audio.' + ext);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVEN_API_KEY },
    body: form,
  });
  if (!r.ok) throw new Error('STT ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  return data.text || '';
}

async function handleSpeak(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'bad json' }, 400);
  }
  if (!body.text) return jsonResponse({ error: 'missing text' }, 400);
  if (!env.ELEVEN_API_KEY) return jsonResponse({ error: 'ELEVEN_API_KEY not configured on the Worker' }, 500);
  const voiceId = env.ELEVEN_VOICE_ID || 'ErXwobaYiN019PkySvjV'; // default until Eric picks Bartleby's voice
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': env.ELEVEN_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: body.text, model_id: 'eleven_multilingual_v2' }),
  });
  if (!r.ok) return jsonResponse({ error: 'TTS ' + r.status + ': ' + (await r.text()).slice(0, 200) }, 500);
  return new Response(r.body, { headers: { 'content-type': 'audio/mpeg' } });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/converse' && request.method === 'POST') {
        return await handleConverse(request, env);
      }
      if (url.pathname === '/api/speak' && request.method === 'POST') {
        return await handleSpeak(request, env);
      }
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, 500);
    }
    return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  },
};
