// Logique commune à l'appli (navigateur) et au serveur (Worker Cloudflare).

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };

export const DEFAULT_SETTINGS = { morning: '07:30', weekly: '07:00', homework: '18:00', evening: '20:30', eveningOn: false, updatedAt: 0 };

export const live = arr => (arr || []).filter(x => !x.deleted);

/* ---------- Séances (récurrence + exceptions) ---------- */
// Séances entre from et to (inclus), y compris annulées (cancelled:true).
export function occurrences(db, from, to) {
  const out = [];
  for (const ev of live(db.events)) {
    const bases = [];
    if (ev.repeat === 'weekly') {
      for (let d = ev.date; d <= to; d = addDays(d, 7)) bases.push(d);
    } else {
      bases.push(ev.date);
    }
    for (const base of bases) {
      const ex = (ev.exceptions || {})[base];
      let date = base, time = ev.time, cancelled = false, moved = false;
      if (ex && ex.cancelled) cancelled = true;
      if (ex && ex.moveTo) { date = ex.moveTo.date; time = ex.moveTo.time; moved = true; }
      if (date < from || date > to) continue;
      out.push({ ev, orig: base, date, time, cancelled, moved });
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

export function hwDue(db, h) {
  return h.dueNext ? nextSessionDate(db, h.subjectId, h.created) : (h.due || null);
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
