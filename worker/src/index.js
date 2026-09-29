import { buildPushPayload } from '@block65/webcrypto-web-push';
import {
  mergeDb, restoreSnapshot, occurrences, hwDue, live, addDays, parse, DEFAULT_SETTINGS,
  evReminders, pendingHomework, practiced, weekStart, daysBetween, weekPracticeDays,
} from '../../shared.js';

const TZ = 'Europe/Paris';
const ALLOWED_ORIGINS = ['https://philophrosyna.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const MAX_BODY = 512 * 1024;
const BACKUP_TTL = 60 * 60 * 24 * 45; // 45 jours d'historique
const BACKUP_HOUR_MIN = 3 * 60;       // sauvegarde automatique vers 3 h (Paris)
const MAX_FAILS = 5;
const FAIL_TTL = 15 * 60;

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
const putJson = (env, key, value, opts) => env.KV.put(key, JSON.stringify(value), opts);
const EMPTY = () => ({ subjects: [], events: [], homework: [], practice: {}, settings: DEFAULT_SETTINGS });

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
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const REM_LABEL = { 1440: 'demain', 120: 'dans 2 h', 60: 'dans 1 h', 30: 'dans 30 min', 15: 'dans 15 min' };

/* ---------- Composition des notifications ---------- */
export function buildMessages(data, now) {
  const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const subj = id => (data.subjects || []).find(x => x.id === id)?.name || '';
  const out = [];
  const due = t => now.min >= toMin(t) && now.min < toMin(t) + 60;
  const { oneOff, recurring } = pendingHomework(data, now.date);
  const pendingCount = oneOff.length + recurring.length;
  const label = o => `${o.time ? o.time + (o.ev.endTime && o.ev.endTime > o.time ? '–' + o.ev.endTime : '') + ' ' : ''}${o.ev.title}${o.days > 1 ? ` (jour ${o.day}/${o.days})` : ''}`;

  // Récap du matin
  if (due(s.morning)) {
    const today = occurrences(data, now.date, now.date).filter(o => !o.cancelled);
    if (today.length) out.push({ key: `morning:${now.date}`, title: "Aujourd'hui", body: today.map(label).join('\n') });
  }

  // Récap du lundi
  if (now.dow === 1 && due(s.weekly)) {
    const week = occurrences(data, now.date, addDays(now.date, 6)).filter(o => !o.cancelled);
    if (week.length) {
      out.push({
        key: `weekly:${now.date}`, title: 'Cette semaine',
        body: week.map(o => `${dayLabel(o.date)} ${label(o)}`).join('\n'),
      });
    }
  }

  // Rappel quotidien des devoirs
  if (pendingCount && due(s.homework)) {
    const tomorrow = addDays(now.date, 1);
    const lines = [
      ...oneOff.map(h => ({ h, d: hwDue(data, h) })).sort((a, b) => (a.d || '9').localeCompare(b.d || '9'))
        .map(({ h, d }) => {
          const tag = d && d < now.date ? ' (en retard)' : d === now.date ? " (aujourd'hui)" : d === tomorrow ? ' (demain)' : '';
          return `${subj(h.subjectId)} : ${h.title}${tag}`;
        }),
      ...recurring.map(h => `${subj(h.subjectId)} : ${h.title}`),
    ];
    out.push({ key: `homework:${now.date}`, title: `Devoirs à faire (${pendingCount})`, body: lines.join('\n') });
  }

  // Notif du soir (facultative)
  if (s.eveningOn && pendingCount && due(s.evening)) {
    out.push({ key: `evening:${now.date}`, title: 'Devoirs', body: `Il te reste ${plural(pendingCount, 'devoir')} à cocher.` });
  }

  // Objectif hebdomadaire de violon : rappel quand il ne reste plus de marge.
  if (s.practiceGoal > 0 && due(s.goalTime) && !practiced(data, now.date)) {
    const needed = s.practiceGoal - weekPracticeDays(data, now.date);
    const daysLeft = 7 - daysBetween(weekStart(now.date), now.date); // aujourd'hui inclus
    if (needed > 0 && needed >= daysLeft) {
      out.push({
        key: `goal:${now.date}`, title: 'Violon',
        body: `Objectif de la semaine : il te reste ${plural(needed, 'jour')} de pratique pour ${plural(daysLeft, 'jour')} restant${daysLeft > 1 ? 's' : ''}. Pratique aujourd'hui !`,
      });
    }
  }

  // Bilan du dimanche soir (facultatif)
  if (s.recapOn && now.dow === 0 && due(s.recapTime)) {
    const ws = weekStart(now.date);
    const hw = live(data.homework);
    const done = hw.filter(h => !h.recur && h.done && (h.doneAt || '').slice(0, 10) >= ws).length
      + hw.filter(h => h.recur).reduce((n, h) => n + Object.keys(h.doneOn || {}).filter(d => d >= ws && d <= now.date).length, 0);
    const lines = [`Devoirs faits : ${done}`];
    const days = weekPracticeDays(data, now.date);
    lines.push(`Violon : ${plural(days, 'jour')} de pratique${s.practiceGoal > 0 ? ` sur ${s.practiceGoal} visés` : ''}`);
    const next = occurrences(data, addDays(now.date, 1), addDays(now.date, 7)).filter(o => !o.cancelled && o.day === 1);
    if (next.length) lines.push('Semaine prochaine : ' + next.map(o => `${dayLabel(o.date)} ${o.time ? o.time + ' ' : ''}${o.ev.title}`).join(', '));
    if (pendingCount) lines.push(`Devoirs restants : ${pendingCount}`);
    out.push({ key: `recap:${now.date}`, title: 'Bilan de la semaine', body: lines.join('\n') });
  }

  // Rappels avant les séances (plusieurs possibles par événement)
  const nowAbs = absMin(now.date, now.min);
  for (const o of occurrences(data, now.date, addDays(now.date, 2))) {
    if (o.cancelled || !o.time || o.day !== 1) continue;
    const at = absMin(o.date, toMin(o.time));
    for (const r of evReminders(o.ev)) {
      // Le rappel part à son heure (tolérance de 20 min si un passage est manqué), jamais après le début.
      if (nowAbs >= at - r && nowAbs < Math.min(at, at - r + 20)) {
        out.push({
          key: `rem:${o.ev.id}@${o.orig}:${o.date}:${o.time}:${r}`, title: o.ev.title,
          body: `${o.date === now.date ? "Aujourd'hui" : dayLabel(o.date)} à ${o.time}${o.ev.place ? ' · ' + o.ev.place : ''}${REM_LABEL[r] ? ' (' + REM_LABEL[r] + ')' : ''}`,
        });
      }
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

// Sauvegarde quotidienne : une copie datée des données, conservée 45 jours.
async function dailyBackup(env, data, now) {
  if (now.min < BACKUP_HOUR_MIN || now.min >= BACKUP_HOUR_MIN + 60) return;
  const key = `backup:${now.date}`;
  if (await env.KV.get(key) !== null) return;
  await putJson(env, key, data, { expirationTtl: BACKUP_TTL });
}

async function runCron(env) {
  const data = await getJson(env, 'data', null);
  if (!data) return;
  const now = parisNow();
  await dailyBackup(env, data, now);

  const subs = await getJson(env, 'subs', []);
  if (!subs.length) return;
  const sent = await getJson(env, 'sent', {});
  const toSend = buildMessages(data, now).filter(m => !sent[m.key]);
  if (!toSend.length) return;

  let dead = [];
  let last = null;
  for (const m of toSend) {
    const r = await pushTo(env, subs, m);
    if (r.ok > 0) { sent[m.key] = now.date; last = { at: new Date().toISOString(), title: m.title }; }
    dead = dead.concat(r.dead);
  }
  if (last) await putJson(env, 'lastSend', last);
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

  // Protection contre les essais de codes : 5 échecs par adresse IP = blocage 15 minutes.
  // Le compteur n'est écrit que tant que la limite n'est pas atteinte (ménage le quota d'écritures).
  const ip = req.headers.get('CF-Connecting-IP') || 'inconnu';
  const failKey = `fail:${ip}`;
  const fails = Number(await env.KV.get(failKey)) || 0;
  if (fails >= MAX_FAILS) return json(req, { error: 'too many attempts' }, 429);
  if (!(await authorized(req, env))) {
    await env.KV.put(failKey, String(fails + 1), { expirationTtl: FAIL_TTL });
    return json(req, { error: 'unauthorized' }, 401);
  }

  const text = await req.text();
  if (text.length > MAX_BODY) return json(req, { error: 'too large' }, 413);
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (e) { return json(req, { error: 'bad json' }, 400); }

  // Synchro : le client envoie ses données seulement s'il a des modifications (data) et la version
  // du serveur qu'il connaît (rev). Si rien n'a changé des deux côtés, la réponse est minuscule.
  if (url.pathname === '/api/sync') {
    const stored = await getJson(env, 'data', EMPTY());
    let rev = stored._rev || 0;
    let merged = stored;
    if (body.data) {
      const m = mergeDb(stored, body.data);
      const { _rev, ...before } = stored;
      if (JSON.stringify(m) !== JSON.stringify(before)) {
        rev = Date.now();
        merged = { ...m, _rev: rev };
        await putJson(env, 'data', merged);
      }
    }
    if (body.rev != null && body.rev === rev && !(body.data && merged !== stored)) return json(req, { rev, unchanged: true });
    const { _rev, ...data } = merged;
    return json(req, { rev, data });
  }

  if (url.pathname === '/api/status') {
    const subs = await getJson(env, 'subs', []);
    return json(req, { lastSend: await getJson(env, 'lastSend', null), subscriptions: subs.length });
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
    if (r.ok) await putJson(env, 'lastSend', { at: new Date().toISOString(), title: 'Test' });
    return json(req, { sent: r.ok, subscriptions: subs.length });
  }

  // Sauvegardes : liste, création immédiate, restauration.
  if (url.pathname === '/api/backups') {
    const list = await env.KV.list({ prefix: 'backup:' });
    const dates = list.keys.map(k => k.name.slice('backup:'.length)).sort().reverse();
    return json(req, { dates });
  }

  if (url.pathname === '/api/backup') {
    const data = await getJson(env, 'data', null);
    if (!data) return json(req, { error: 'no data' }, 404);
    await putJson(env, `backup:${parisNow().date}`, data, { expirationTtl: BACKUP_TTL });
    return json(req, { ok: true });
  }

  if (url.pathname === '/api/restore') {
    const date = String(body.date || '');
    if (!/^(\d{4}-\d{2}-\d{2}|avant-restauration)$/.test(date)) return json(req, { error: 'bad date' }, 400);
    const snap = await getJson(env, `backup:${date}`, null);
    if (!snap) return json(req, { error: 'not found' }, 404);
    const current = await getJson(env, 'data', EMPTY());
    // Filet de sécurité : l'état actuel est mis de côté avant d'être remplacé.
    await putJson(env, `backup:avant-restauration`, current, { expirationTtl: BACKUP_TTL });
    const restored = restoreSnapshot(current, snap, Date.now());
    const rev = Date.now();
    await putJson(env, 'data', { ...restored, _rev: rev });
    return json(req, { rev, data: restored });
  }

  return json(req, { error: 'not found' }, 404);
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json(req, { error: 'server error' }, 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(runCron(env)),
};
