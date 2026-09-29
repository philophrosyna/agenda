// Logique commune à l'appli (navigateur) et au serveur (Worker Cloudflare).

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
// Lundi de la semaine contenant la date.
export const weekStart = s => addDays(s, -((parse(s).getDay() + 6) % 7));

export const DEFAULT_SETTINGS = {
  morning: '07:30', weekly: '07:00', homework: '18:00', evening: '20:30', eveningOn: false,
  practiceGoal: 0, goalTime: '19:00', updatedAt: 0,
};

export const live = arr => (arr || []).filter(x => !x.deleted);

/* ---------- Séances (récurrence, fin de récurrence, multi-jours, exceptions) ---------- */
// Rappels d'un événement (anciens événements : un seul rappel dans reminderMin).
export const evReminders = ev => ev.reminders ?? (ev.reminderMin != null ? [ev.reminderMin] : []);

// Séances entre from et to (inclus), y compris annulées (cancelled:true).
// Un événement sur plusieurs jours donne une séance par jour (day/days).
export function occurrences(db, from, to) {
  const out = [];
  for (const ev of live(db.events)) {
    const weekly = ev.repeat === 'weekly';
    const span = weekly ? 0 : Math.max(0, daysBetween(ev.date, ev.endDate || ev.date));
    const bases = [];
    if (weekly) {
      const last = ev.until && ev.until < to ? ev.until : to;
      for (let d = ev.date; d <= last; d = addDays(d, 7)) bases.push(d);
    } else {
      bases.push(ev.date);
    }
    for (const base of bases) {
      const ex = (ev.exceptions || {})[base];
      let start = base, time = ev.time, cancelled = false, moved = false;
      if (ex && ex.cancelled) cancelled = true;
      if (ex && ex.moveTo) { start = ex.moveTo.date; time = ex.moveTo.time; moved = true; }
      for (let i = 0; i <= span; i++) {
        const date = addDays(start, i);
        if (date < from || date > to) continue;
        out.push({ ev, orig: base, date, time: i === 0 ? time : '', cancelled, moved, day: i + 1, days: span + 1 });
      }
    }
  }
  return out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

// Date de la prochaine séance (non annulée) d'une matière, strictement après `after`.
export function nextSessionDate(db, subjectId, after) {
  const list = occurrences(db, addDays(after, 1), addDays(after, 120))
    .filter(o => !o.cancelled && o.ev.subjectId === subjectId);
  return list.length ? list[0].date : null;
}

/* ---------- Devoirs ---------- */
export function hwDue(db, h) {
  return h.dueNext ? nextSessionDate(db, h.subjectId, h.created) : (h.due || null);
}

// Devoir récurrent : à faire ce jour-là ? (recur = { days: [0..6] }, 0 = dimanche)
export const recurDue = (h, date) => !!h.recur && h.recur.days.includes(parse(date).getDay()) && date >= h.created;
export const recurDone = (h, date) => !!(h.doneOn && h.doneOn[date]);

// Devoirs restants à la date donnée : ponctuels non cochés + récurrents du jour non cochés.
export function pendingHomework(db, date) {
  const all = live(db.homework);
  return {
    oneOff: all.filter(h => !h.recur && !h.done),
    recurring: all.filter(h => h.recur && recurDue(h, date) && !recurDone(h, date)),
  };
}

/* ---------- Pratique du violon ---------- */
export const practiced = (db, d) => !!(db.practice || {})[d] && !db.practice[d].deleted;
export const minutesOn = (db, d) => (practiced(db, d) ? db.practice[d].minutes || 0 : 0);

export function currentStreak(db, today) {
  let d = today;
  if (!practiced(db, d)) d = addDays(d, -1); // la série reste valable tant que la journée n'est pas finie
  let n = 0;
  while (practiced(db, d)) { n++; d = addDays(d, -1); }
  return n;
}

export function bestStreak(db) {
  const days = Object.keys(db.practice || {}).filter(d => practiced(db, d)).sort();
  let best = 0, cur = 0, prev = null;
  for (const d of days) {
    cur = prev && addDays(prev, 1) === d ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  return best;
}

// Jours pratiqués dans la semaine (lundi-dimanche) de la date, jusqu'à la date incluse.
export function weekPracticeDays(db, date) {
  const ws = weekStart(date);
  let n = 0;
  for (let d = ws; d <= date; d = addDays(d, 1)) if (practiced(db, d)) n++;
  return n;
}

/* ---------- Fusion (synchro entre appareils) ---------- */
// Chaque enregistrement porte un `updatedAt` ; le plus récent l'emporte.
// Les suppressions sont des enregistrements `deleted: true` (pour se propager).
const newer = (a, b) => (b.updatedAt || 0) > (a.updatedAt || 0);

function mergeById(x = [], y = []) {
  const m = new Map();
  for (const r of [...x, ...y]) {
    const c = m.get(r.id);
    if (!c || newer(c, r)) m.set(r.id, r);
  }
  return [...m.values()];
}

function mergeMap(x = {}, y = {}) {
  const out = { ...x };
  for (const k of Object.keys(y)) if (!out[k] || newer(out[k], y[k])) out[k] = y[k];
  return out;
}

export function mergeDb(a, b) {
  return {
    subjects: (a.subjects && a.subjects.length) ? a.subjects : b.subjects,
    events: mergeById(a.events, b.events),
    homework: mergeById(a.homework, b.homework),
    practice: mergeMap(a.practice, b.practice),
    settings: newer(a.settings || {}, b.settings || {}) ? b.settings : (a.settings || DEFAULT_SETTINGS),
  };
}

// Restauration d'une sauvegarde : tout est re-daté « maintenant » pour l'emporter sur les autres appareils ;
// ce qui existe aujourd'hui mais pas dans la sauvegarde est marqué supprimé.
export function restoreSnapshot(current, snap, now) {
  const stamp = r => ({ ...r, updatedAt: now });
  const arr = k => {
    const kept = new Set((snap[k] || []).map(x => x.id));
    return [
      ...(snap[k] || []).map(stamp),
      ...live(current[k]).filter(x => !kept.has(x.id)).map(x => ({ ...x, deleted: true, updatedAt: now })),
    ];
  };
  const practice = Object.fromEntries(Object.entries(snap.practice || {}).map(([k, v]) => [k, stamp(v)]));
  for (const k of Object.keys(current.practice || {})) {
    if (!practice[k] && practiced(current, k)) practice[k] = { deleted: true, updatedAt: now };
  }
  return {
    subjects: snap.subjects && snap.subjects.length ? snap.subjects : current.subjects,
    events: arr('events'),
    homework: arr('homework'),
    practice,
    settings: { ...DEFAULT_SETTINGS, ...(snap.settings || {}), updatedAt: now },
  };
}
