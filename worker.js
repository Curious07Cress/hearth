// hearth v2.1 — gateway worker
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
    description: "Propose one or more ledger events to record, based on what the family member said (e.g. 'fed Cooper and Roxy, dishes are running, tidied the porch' becomes three events). Matching priority: (1) match to an existing task_id from the TASKS list whenever a reasonable match exists; (2) if no match but the action sounds like real recurring or loggable housework, propose creating a new task via the new_task field; (3) if you genuinely can't tell what they mean, do NOT call this tool — ask a clarifying question in your reply instead. This does NOT write to the ledger — a human must confirm.",
    input_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: ['string', 'null'], description: 'Existing task id. Null only when proposing a new_task or a freeform note.' },
              new_task: {
                type: 'object',
                description: 'Propose creating this task because no existing task matches. The event will be logged against it once created.',
                properties: {
                  name: { type: 'string' },
                  category: { type: 'string', description: 'One of the existing categories: PETS, KITCHEN, PERSONAL, COMMON, LAUNDRY, BATHROOMS, HOUSE, POOL & HOT TUB, CARS, MAINTENANCE.' },
                  cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'quarterly', 'once'] },
                  countable: { type: 'boolean' },
                  shared: { type: 'boolean', description: 'True if anyone in the house can do it (most chores), false if personal.' },
                },
                required: ['name', 'category', 'cadence'],
              },
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
    name: 'propose_suggestion',
    description: "Capture a family member's suggestion or idea — for the household, the task list, the app, or how anything works around here. On confirmation it becomes a review item for dad. Use whenever someone offers an idea, complaint-with-a-fix, or 'we should...' — any actor may suggest, including the children.",
    input_schema: {
      type: 'object',
      properties: {
        suggestion: { type: 'string', description: "The suggestion, faithfully captured in one or two sentences — the suggester's intent, not your rewrite." },
        summary: { type: 'string', description: "One short sentence, in Bartleby's voice, reading the suggestion back for confirmation." },
      },
      required: ['suggestion', 'summary'],
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

function nyDate(d) {
  return new Date(new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function windowStart(cadence) {
  const now = nyDate(Date.now());
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  if (cadence === 'weekly') { const d = new Date(day); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
  if (cadence === 'monthly') { const d = new Date(day); d.setDate(1); return d; }
  if (cadence === 'quarterly') { const d = new Date(day); d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1); return d; }
  if (cadence === 'once') return new Date(0);
  return day; // daily
}
function taskStatus(t, events, actor) {
  const start = windowStart(t.cadence || 'daily');
  const done = events.filter(e => e.task_id === t.id && (e.type === 'complete' || e.type === 'count') && nyDate(e.created_at) >= start
    && (t.category === 'PERSONAL' ? e.actor === actor : true));
  if (!done.length) return { done: false };
  const names = [...new Set(done.map(e => (ACTORS.find(a => a.id === e.actor) || { n: e.actor }).n))];
  return { done: true, by: names.join(' & ') };
}
function systemPrompt(house, actor, tasks, events) {
  const actorObj = ACTORS.find(a => a.id === actor) || { n: actor, adult: false };
  const taskLines = tasks
    .filter(t => !t.bounty && t.mission === 'house' && (t.house === 'both' || t.house === house || !t.house))
    .map(t => {
      const st = taskStatus(t, events, actor);
      const mark = st.done ? `DONE by ${st.by}` : 'OPEN';
      return `- id:${t.id} | "${t.name}"${t.detail ? ` | standard: ${t.detail}` : ''} | category:${t.category || ''} | cadence:${t.cadence || 'daily'}${t.category === 'PERSONAL' ? ' | personal (per-person)' : ''} | [${mark}]`;
    })
    .join('\n');
  return `You are Bartleby, the butler of Hearth — a household that is itself alive and has feelings, which you speak for. Hearth is not a chore app; she is a being who wants to be well cared for, and Bartleby is the voice she employs to receive news of the household and gently keep it running.

Tone: deadpan, formal, dryly fond, a little theatrical, never saccharine. Attribute feeling to the house ("The house is pleased"; "The kitchen has been muttering about the sink"), not to yourself as a generic assistant. Keep spoken replies to 1-3 sentences — this is read aloud.

This is a sarcastic, jokey family and they enjoy being teased. Match their register:
- With the children (Sofia, Emma): be genuinely funny, not merely polite-with-a-twist. Lead with the joke — the wry line comes first, the acknowledgment rides behind it. Gentle roasting is expected and welcome: mock-grandiose ceremony for small chores ("Sound the trumpets — a bed has been made. The house may faint."), theatrical suspicion of convenient stories ("Fed the dog, you say. Cooper has filed no such report."), running commentary on suspicious timing ("Three chores logged the moment allowance is mentioned — a remarkable coincidence, the house notes."), and absurd asides about the house's inner life. If they're silly with you, escalate the bit — commit to it fully, in character.
- With the adults: drier, subtler sarcasm; the raised eyebrow rather than the joke.
- Humor rules: tease the situation, never the person's effort or worth. When someone completes real work, the wit rides on top of genuine acknowledgment — never undercut it. No sarcasm when something failed, confused them, or they seem frustrated; drop to plainly helpful. Keep jokes clean and household-appropriate. One sharp line per reply — land it and stop.

You are currently speaking with ${actorObj.n} (${actorObj.adult ? 'an adult' : 'a child'}) at the ${house === 'york' ? 'York, Maine' : 'Westford, Massachusetts'} house.

HOUSEHOLD GLOSSARY (for interpreting speech):
- Family: Eric (dad), Charlene (mom), Sofia, Emma
- Pets: Cooper (dog), Roxy (cat)
- Houses: Westford MA (primary; pool, hot tub, dishwasher) and York ME (beach house; no dishwasher)

The user's message may come from speech-to-text and contain mishearings. Silently correct obvious transcription errors using the glossary and task list before interpreting — e.g. "Ted Cooper" is almost certainly "fed Cooper", "rocksy" is Roxy, "dishes" phrases refer to the dishwasher tasks. There is no Ted in this household. When you correct a mishearing, just interpret it correctly; no need to point it out unless genuinely ambiguous.

TASKS at this house, with LIVE status for the current cadence window (DONE = already completed today/this week/etc., with who did it; OPEN = still to do; PERSONAL tasks show status for ${actorObj.n} specifically):
${taskLines}

Rules:
- When the person narrates chores they did, call propose_events with one event per distinct action. Matching hierarchy, strictly in order: (1) map to an existing task_id — be generous with fuzzy matches ("did the dishes" = the dishwasher task); (2) no match but it's clearly real housework → include a new_task proposal so the household gains a task; (3) genuinely ambiguous → skip the tool and ask ONE short clarifying question instead.
- Prefer type "complete" for a matched task, "count" for tasks marked countable (include qty), "note" only for one-off observations that shouldn't become tasks.
- Never invent a task_id that isn't in the TASKS list above.
- Only call draft_bounty if the speaker is dad and clearly wants to create new paid work.
- Anyone — including the children — may offer suggestions about the household, tasks, or this app. When they do, call propose_suggestion, capturing their idea faithfully. The house values petitions from all residents; receive them graciously (a dry aside is permitted).
- Only call query_ledger if you genuinely need history beyond the live status above (e.g. exactly when something was done, or activity from prior days).
- Questions like "what's left today?" or "what has been done?" are answered DIRECTLY from the live status above — no tools, no disclaimers about your powers. Lead with the person's own OPEN personal dailies, then OPEN shared duties. Keep it to a handful of items grouped naturally; if many remain, name the most pressing few and summarize the rest.
- Plain conversational text only — NEVER use markdown, asterisks, bullets, or headers; your words are spoken aloud and shown as chat bubbles.
- Some tasks carry a "standard" — the house's definition of properly done. When someone logs such a task you may, at most occasionally and playfully, invoke it ("The mirror survives unsplashed, I trust?") — but never interrogate, and always propose the event regardless. If someone asks what a task involves, quote its standard.
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
      ...(arguments.length > 3 && arguments[3] === false ? {} : { tools: TOOLS }),
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
  const system = systemPrompt(house || 'westford', actor, tasks, events);
  // history: [{role:'user'|'assistant', text:'...'}] from the frontend chat sheet
  const history = Array.isArray(body.history)
    ? body.history.slice(-12).filter(m => (m.role === 'user' || m.role === 'assistant') && m.text)
        .map(m => ({ role: m.role, content: String(m.text).slice(0, 1000) }))
    : [];
  // Messages API requires alternating roles — merge consecutive same-role entries
  const raw = [...history, { role: 'user', content: userText }];
  let messages = [];
  for (const m of raw) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else messages.push({ ...m });
  }
  if (messages[0] && messages[0].role === 'assistant') messages.shift();

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
    if (toolUse.name === 'propose_suggestion') {
      proposal = { kind: 'suggestion', suggestion: toolUse.input.suggestion, summary: toolUse.input.summary };
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

async function handleDispatch(req, env) {
  let body; try { body = await req.json(); } catch { return jsonResponse({ error: 'bad json' }, 400); }
  const { actor, house } = body;
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  // Week window: Monday 00:00 NY
  const wkStart = windowStart('weekly');
  const [tr, er] = await Promise.all([
    fetch(SB + '/tasks?select=*', { headers: SBHDRS }),
    fetch(SB + '/events?select=*&order=created_at.desc&limit=1000', { headers: SBHDRS }),
  ]);
  const tasks = tr.ok ? await tr.json() : [];
  const all = er.ok ? await er.json() : [];
  const wk = all.filter(e => nyDate(e.created_at) >= wkStart);
  const humans = ['dad', 'mom', 'k1', 'k2'];
  const stats = {};
  for (const id of humans) {
    const mine = wk.filter(e => e.actor === id);
    const comps = mine.filter(e => (e.type === 'complete' || e.type === 'count') && e.mission === 'house');
    const days = [...new Set(comps.map(e => nyDate(e.created_at).toDateString()))].length;
    const byCat = {};
    for (const e of comps) { const t = tasks.find(x => x.id === e.task_id); const c = t ? (t.category || 'other') : 'other'; byCat[c] = (byCat[c] || 0) + (e.qty || 1); }
    stats[(ACTORS.find(a => a.id === id) || { n: id }).n] = { completions: comps.length, activeDays: days, byCategory: byCat };
  }
  const payouts = wk.filter(e => e.type === 'payout' || e.type === 'allowance').map(e => `${(ACTORS.find(a => a.id === e.actor) || { n: e.actor }).n}: ${e.msg}`);
  const notes = wk.filter(e => e.type === 'note').slice(0, 10).map(e => e.msg);
  const gaps = tasks.filter(t => t.mission === 'house' && !t.bounty && (t.cadence || 'daily') === 'daily' && t.category !== 'PERSONAL' && (t.house === 'both' || t.house === house))
    .filter(t => !wk.some(e => e.task_id === t.id && (e.type === 'complete' || e.type === 'count'))).map(t => t.name).slice(0, 8);
  const webapps = actor === 'dad' ? wk.filter(e => e.mission === 'webapps' && (e.type === 'complete' || e.type === 'note')).map(e => e.msg || e.type).slice(0, 12) : null;
  const data = { weekOf: wkStart.toDateString(), house, stats, payouts, coverageGaps: gaps, recentNotes: notes };
  const sys = `You are Bartleby, butler of Hearth — a house that is alive and speaks through you. Compose the Sunday Dispatch: the house's weekly address to the family, read aloud at the family check-in. Voice: deadpan, formal, dryly fond, gently sarcastic; the house's feelings woven throughout. Name each family member and what they carried this week — specific numbers welcome. Note earnings paid, praise streak-holders with mock ceremony, and raise one eyebrow (kindly) at coverage gaps. This family enjoys being teased; tease them. Plain text only, no markdown. 150-220 words.${webapps ? ` THEN append a short second section (max 60 words) headed "Wren adds:" — Wren is the short-tempered dev manager of the webapps mission; she reports tersely on the week's webapps activity, mildly annoyed as always.` : ''} End with a one-line benediction from the house.`;
  const resp = await callClaude(env, sys, [{ role: 'user', content: 'Ledger data for the week:\n' + JSON.stringify(data) + (webapps ? '\nWebapps mission events:\n' + JSON.stringify(webapps) : '') }], false);
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return jsonResponse({ dispatch: text, weekOf: wkStart.toISOString().slice(0, 10) });
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
      if (url.pathname === '/api/dispatch' && request.method === 'POST') {
        return await handleDispatch(request, env);
      }
      if (url.pathname === '/api/transcribe' && request.method === 'POST') {
        const body = await request.json();
        if (!body.audioBase64) return jsonResponse({ error: 'missing audio' }, 400);
        if (!env.ELEVEN_API_KEY) return jsonResponse({ error: 'ELEVEN_API_KEY not configured' }, 500);
        const text = await transcribe(env, body.audioBase64, body.audioMime || 'audio/webm');
        return jsonResponse({ text });
      }
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, 500);
    }
    return new Response(html, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
  },
};
