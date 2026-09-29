import { buildPushPayload } from '@block65/webcrypto-web-push';
import { mergeDb, occurrences, hwDue, live, addDays, parse, DEFAULT_SETTINGS } from '../../shared.js';

const TZ = 'Europe/Paris';
const ALLOWED_ORIGINS = ['https://philophrosyna.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const MAX_BODY = 512 * 1024;

/* ---------- Utilitaires ---------- */
function cors(req) {
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

async function authorized(req, env) {
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!env.ACCESS_CODE || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ACCESS_CODE)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const getJson = async (env, key, fallback) => (await env.KV.get(key, 'json')) ?? fallback;
const putJson = (env, key, value) => env.KV.put(key, JSON.stringify(value));

/* ---------- Heure de Paris ---------- */
function parisNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const min = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, min, dow: parse(date).getDay() };
}
const toMin = hhmm => { const [h, m] = (hhmm || '').split(':').map(Number); return h * 60 + m; };
// Minutes absolues d'une date/heure « murales » (sert uniquement à comparer entre elles).
const absMin = (date, min) => Math.floor(parse(date).getTime() / 60000) + min;
const dayLabel = date => parse(date).toLocaleDateString('fr-FR', { weekday: 'short' });

/* ---------- Composition des notifications ---------- */
export function buildMessages(data, now) {
  const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const subj = id => (data.subjects || []).find(x => x.id === id)?.name || '';
  const out = [];
  const due = t => now.min >= toMin(t) && now.min < toMin(t) + 60;
  const pending = live(data.homework).filter(h => !h.done);

  // Récap du matin
  if (due(s.morning)) {
    const today = occurrences(data, now.date, now.date).filter(o => !o.cancelled);
    if (today.length) {
      out.push({
        key: `morning:${now.date}`, title: "Aujourd'hui",
        body: today.map(o => `${o.time ? o.time + ' ' : ''}${o.ev.title}`).join('\n'),
      });
    }
  }

  // Récap du lundi
  if (now.dow === 1 && due(s.weekly)) {
    const week = occurrences(data, now.date, addDays(now.date, 6)).filter(o => !o.cancelled);
    if (week.length) {
      out.push({
        key: `weekly:${now.date}`, title: 'Cette semaine',
        body: week.map(o => `${dayLabel(o.date)} ${o.time ? o.time + ' ' : ''}${o.ev.title}`).join('\n'),
      });
    }
  }

  // Rappel quotidien des devoirs
  if (pending.length && due(s.homework)) {
    const tomorrow = addDays(now.date, 1);
    const lines = pending
      .map(h => ({ h, d: hwDue(data, h) }))
      .sort((a, b) => (a.d || '9').localeCompare(b.d || '9'))
      .map(({ h, d }) => {
        const tag = d && d < now.date ? ' (en retard)' : d === now.date ? " (aujourd'hui)" : d === tomorrow ? ' (demain)' : '';
        return `${subj(h.subjectId)} : ${h.title}${tag}`;
      });
    out.push({ key: `homework:${now.date}`, title: `Devoirs à faire (${pending.length})`, body: lines.join('\n') });
  }

  // Notif du soir (facultative)
  if (s.eveningOn && pending.length && due(s.evening)) {
    out.push({
      key: `evening:${now.date}`, title: 'Devoirs',
      body: `Il te reste ${pending.length} devoir${pending.length > 1 ? 's' : ''} à cocher.`,
    });
  }

  // Rappels avant cours
  const nowAbs = absMin(now.date, now.min);
  for (const o of occurrences(data, now.date, addDays(now.date, 2))) {
    const r = o.ev.reminderMin;
    if (o.cancelled || r == null || !o.time) continue;
    const at = absMin(o.date, toMin(o.time));
    if (nowAbs >= at - r && nowAbs < at) {
      out.push({
        key: `rem:${o.ev.id}@${o.orig}:${o.date}:${o.time}`, title: o.ev.title,
        body: `${o.date === now.date ? 'Aujourd\'hui' : dayLabel(o.date)} à ${o.time}${o.ev.place ? ' · ' + o.ev.place : ''}`,
      });
    }
  }
  return out;
}

/* ---------- Envoi ---------- */
async function pushTo(env, subs, msg) {
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const dead = [];
  let ok = 0;
  for (const sub of subs) {
    try {
      const payload = await buildPushPayload(
        { data: JSON.stringify({ title: msg.title, body: msg.body, tag: msg.key || 'agenda' }), options: { ttl: 3600, urgency: 'high' } },
        sub, vapid);
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
      else if (res.ok) ok++;
    } catch (e) { /* on réessaiera au prochain passage si la clé n'est pas marquée envoyée */ }
  }
  return { ok, dead };
}

async function runCron(env) {
  const subs = await getJson(env, 'subs', []);
  if (!subs.length) return;
  const data = await getJson(env, 'data', null);
  if (!data) return;
  const now = parisNow();
  const sent = await getJson(env, 'sent', {});
  const toSend = buildMessages(data, now).filter(m => !sent[m.key]);
  if (!toSend.length) return;

  let dead = [];
  for (const m of toSend) {
    const r = await pushTo(env, subs, m);
    if (r.ok > 0) sent[m.key] = now.date;
    dead = dead.concat(r.dead);
  }
  // Purge des clés d'envoi de plus de 3 jours.
  const limit = addDays(now.date, -3);
  for (const k of Object.keys(sent)) if (sent[k] < limit) delete sent[k];
  await putJson(env, 'sent', sent);
  if (dead.length) await putJson(env, 'subs', subs.filter(s => !dead.includes(s.endpoint)));
}

/* ---------- API ---------- */
async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  if (req.method !== 'POST') return json(req, { error: 'not found' }, 404);
  if (!(await authorized(req, env))) return json(req, { error: 'unauthorized' }, 401);

  const text = await req.text();
  if (text.length > MAX_BODY) return json(req, { error: 'too large' }, 413);
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (e) { return json(req, { error: 'bad json' }, 400); }

  if (url.pathname === '/api/sync') {
    const stored = await getJson(env, 'data', { subjects: [], events: [], homework: [], practice: {}, settings: DEFAULT_SETTINGS });
    const merged = mergeDb(stored, body.data || {});
    if (JSON.stringify(merged) !== JSON.stringify(stored)) await putJson(env, 'data', merged);
    return json(req, { data: merged });
  }

  if (url.pathname === '/api/subscribe') {
    const sub = body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) return json(req, { error: 'bad subscription' }, 400);
    const all = await getJson(env, 'subs', []);
    const known = all.find(s => s.endpoint === sub.endpoint);
    if (known && JSON.stringify(known.keys) === JSON.stringify(sub.keys)) return json(req, { ok: true, count: all.length });
    const subs = all.filter(s => s.endpoint !== sub.endpoint);
    subs.push(sub);
    await putJson(env, 'subs', subs);
    return json(req, { ok: true, count: subs.length });
  }

  if (url.pathname === '/api/unsubscribe') {
    const subs = (await getJson(env, 'subs', [])).filter(s => s.endpoint !== body.endpoint);
    await putJson(env, 'subs', subs);
    return json(req, { ok: true });
  }

  if (url.pathname === '/api/test') {
    const subs = await getJson(env, 'subs', []);
    const r = await pushTo(env, subs, { key: 'test', title: 'Agenda', body: 'Les notifications fonctionnent ✓' });
    return json(req, { sent: r.ok, subscriptions: subs.length });
  }

  return json(req, { error: 'not found' }, 404);
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json(req, { error: 'server error' }, 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(runCron(env)),
};
