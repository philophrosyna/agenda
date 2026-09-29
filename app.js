'use strict';

/* ---------- Données ---------- */
const KEY = 'appcal.v1';
const DEFAULTS = () => ({
  subjects: [
    { id: 'chinois', name: 'Chinois', color: '#e0483e' },
    { id: 'violon', name: 'Violon', color: '#7b4fd6' },
    { id: 'autre', name: 'Autre', color: '#2f8f6f' },
  ],
  events: [],     // {id, title, subjectId, date, time, place, note, repeat:'none'|'weekly', reminderMin, exceptions:{[date]:{cancelled}|{moveTo:{date,time}}}, sessionNotes:{[date]:text}}
  homework: [],   // {id, title, subjectId, due:'YYYY-MM-DD'|null, dueNext:boolean, created, done, doneAt}
  practice: {},   // {[date]: {minutes:number|null}}
  settings: { morning: '07:30', weekly: '07:00', homework: '18:00', evening: '20:30', eveningOn: false },
});

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return Object.assign(DEFAULTS(), JSON.parse(raw));
  } catch (e) { /* stockage indisponible */ }
  return DEFAULTS();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
}

/* ---------- Utilitaires ---------- */
const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subject = id => db.subjects.find(s => s.id === id) || db.subjects[db.subjects.length - 1];
const fmtDay = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/* ---------- Occurrences (récurrence + exceptions) ---------- */
// Retourne les séances entre from et to (inclus), y compris annulées (cancelled:true).
function occurrences(from, to) {
  const out = [];
  for (const ev of db.events) {
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
function nextSessionDate(subjectId, after) {
  const list = occurrences(addDays(after, 1), addDays(after, 120))
    .filter(o => !o.cancelled && o.ev.subjectId === subjectId);
  return list.length ? list[0].date : null;
}

function hwDue(h) {
  if (h.dueNext) return nextSessionDate(h.subjectId, h.created);
  return h.due || null;
}

function hwBadge(h) {
  if (h.done) return '';
  const due = hwDue(h);
  if (!due) return h.dueNext ? '<span class="badge">prochain cours</span>' : '';
  const t = today();
  if (due < t) return '<span class="badge late">en retard</span>';
  if (due === t) return '<span class="badge soon">aujourd\'hui</span>';
  if (due === addDays(t, 1)) return '<span class="badge soon">demain</span>';
  return `<span class="badge">${esc(fmtShort(due))}</span>`;
}

function practiceStreak() {
  let d = today();
  if (!db.practice[d]) d = addDays(d, -1); // la série reste valable tant que la journée n'est pas finie
  let n = 0;
  while (db.practice[d]) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------- Rendu ---------- */
let tab = 'today';
const TITLES = { today: "Aujourd'hui", agenda: 'Agenda', homework: 'Devoirs', settings: 'Réglages' };

function render() {
  $('#title').textContent = TITLES[tab];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#fab').classList.toggle('hidden', tab === 'settings');
  $('#view').innerHTML = { today: viewToday, agenda: viewAgenda, homework: viewHomework, settings: viewSettings }[tab]();
  updateBadge();
}

function occRow(o) {
  const s = subject(o.ev.subjectId);
  const meta = [o.time, o.ev.place].filter(Boolean).join(' · ');
  const tag = o.cancelled ? '<span class="badge late">annulé</span>' : (o.moved ? '<span class="badge soon">déplacé</span>' : '');
  return `<div class="row ${o.cancelled ? 'cancelled' : ''}" data-occ="${o.ev.id}@${o.orig}">
    <span class="dot" style="background:${s.color}"></span>
    <div class="grow"><b>${esc(o.ev.title)}</b><small>${esc(meta || s.name)}</small></div>${tag}</div>`;
}

function hwRow(h) {
  const s = subject(h.subjectId);
  return `<div class="row ${h.done ? 'done' : ''}" data-hw="${h.id}">
    <input type="checkbox" class="chk" data-check="${h.id}" ${h.done ? 'checked' : ''}>
    <div class="grow"><b>${esc(h.title)}</b><small><span class="dot" style="background:${s.color};display:inline-block"></span> ${esc(s.name)}</small></div>${hwBadge(h)}</div>`;
}

function viewToday() {
  const t = today();
  const occ = occurrences(t, t);
  const pending = db.homework.filter(h => !h.done);
  const bySubject = {};
  pending.forEach(h => (bySubject[h.subjectId] = bySubject[h.subjectId] || []).push(h));
  const p = db.practice[t];
  const streak = practiceStreak();
  return `
    <h2>${esc(fmtDay(t))}</h2>
    <div class="card">${occ.length ? occ.map(occRow).join('') : '<div class="empty">Rien de prévu aujourd\'hui.</div>'}</div>
    <h2>Devoirs restants</h2>
    <div class="card">${pending.length
      ? Object.values(bySubject).map(list => list.sort((a, b) => (hwDue(a) || '9').localeCompare(hwDue(b) || '9')).map(hwRow).join('')).join('')
      : '<div class="empty">Aucun devoir en attente. 🎉</div>'}</div>
    <h2>Violon</h2>
    <div class="card practice">
      <div class="grow"><div class="streak">${streak} jour${streak > 1 ? 's' : ''}</div><small>de pratique d'affilée</small></div>
      ${p ? `<button class="btn sec small" data-act="unpractice">Pratiqué ✓${p.minutes ? ' · ' + p.minutes + ' min' : ''}</button>`
          : '<button class="btn" data-act="practice">J\'ai pratiqué</button>'}
    </div>`;
}

function viewAgenda() {
  const t = today();
  const occ = occurrences(t, addDays(t, 60));
  if (!occ.length) return '<div class="card"><div class="empty">Aucun événement dans les 60 prochains jours. Appuie sur + pour en ajouter.</div></div>';
  const days = {};
  occ.forEach(o => (days[o.date] = days[o.date] || []).push(o));
  return Object.keys(days).sort().map(d =>
    `<div class="daytitle ${d === t ? 'today' : ''}">${esc(fmtDay(d))}</div><div class="card">${days[d].map(occRow).join('')}</div>`).join('');
}

function viewHomework() {
  const pending = db.homework.filter(h => !h.done).sort((a, b) => (hwDue(a) || '9').localeCompare(hwDue(b) || '9'));
  const done = db.homework.filter(h => h.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 15);
  return `
    <h2>À faire</h2>
    <div class="card">${pending.length ? pending.map(hwRow).join('') : '<div class="empty">Aucun devoir en attente.</div>'}</div>
    ${done.length ? `<h2>Terminés</h2><div class="card">${done.map(hwRow).join('')}</div>
    <div class="actions"><button class="btn sec small" data-act="clear-done">Vider les terminés</button></div>` : ''}`;
}

function viewSettings() {
  const s = db.settings;
  const time = (k, label) => `<div class="setrow"><span>${label}</span><input type="time" data-set="${k}" value="${s[k]}"></div>`;
  return `
    <h2>Horaires des notifications</h2>
    <div class="card">
      ${time('morning', 'Récap du matin')}
      ${time('weekly', 'Récap du lundi')}
      ${time('homework', 'Rappel des devoirs')}
      <div class="setrow"><span>Notif du soir (devoirs restants)</span><input type="checkbox" class="chk" data-set="eveningOn" ${s.eveningOn ? 'checked' : ''}></div>
      ${time('evening', 'Heure de la notif du soir')}
      <div class="note">Les notifications seront activées avec le serveur (étape suivante). Les horaires sont déjà enregistrés.</div>
    </div>
    <h2>Sauvegarde</h2>
    <div class="card"><div class="setrow"><span>Exporter mes données</span><button class="btn sec small" data-act="export">Exporter</button></div>
    <div class="setrow"><span>Importer une sauvegarde</span><button class="btn sec small" data-act="import">Importer</button></div></div>
    <input type="file" id="importFile" accept="application/json" hidden>`;
}

function updateBadge() {
  try {
    const n = db.homework.filter(h => !h.done).length;
    if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch (e) { /* non supporté */ }
}

/* ---------- Boîtes de dialogue ---------- */
const dlg = $('#dlg');
function openDialog(html) { dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
const closeDialog = () => dlg.open && dlg.close();
dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });

const subjectOptions = sel => db.subjects.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
const REMINDERS = [[null, 'Aucun'], [15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, 'La veille']];

function eventForm(ev) {
  const e = ev || { title: '', subjectId: 'chinois', date: today(), time: '18:00', place: '', note: '', repeat: 'none', reminderMin: 60 };
  openDialog(`
    <h3>${ev ? 'Modifier la série' : 'Nouvel événement'}</h3>
    <label>Titre</label><input type="text" id="f-title" value="${esc(e.title)}" placeholder="Cours de chinois">
    <label>Matière</label><select id="f-subject">${subjectOptions(e.subjectId)}</select>
    <label>Date</label><input type="date" id="f-date" value="${e.date}">
    <label>Heure</label><input type="time" id="f-time" value="${e.time || ''}">
    <label>Lieu</label><input type="text" id="f-place" value="${esc(e.place)}">
    <label>Rappel avant</label><select id="f-rem">${REMINDERS.map(([v, l]) => `<option value="${v ?? ''}" ${v === e.reminderMin ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label class="inline"><input type="checkbox" id="f-repeat" ${e.repeat === 'weekly' ? 'checked' : ''}> Répéter chaque semaine</label>
    <div class="actions">
      <button class="btn" data-act="save-event" data-id="${ev ? ev.id : ''}">Enregistrer</button>
      <button class="btn sec" data-act="close">Fermer</button>
      ${ev ? `<button class="btn danger right" data-act="delete-event" data-id="${ev.id}">Supprimer la série</button>` : ''}
    </div>`);
}

function saveEvent(id) {
  const title = $('#f-title').value.trim();
  const date = $('#f-date').value;
  if (!title || !date) { alert('Titre et date obligatoires.'); return; }
  const rem = $('#f-rem').value;
  const data = {
    title, date, subjectId: $('#f-subject').value, time: $('#f-time').value || '',
    place: $('#f-place').value.trim(), repeat: $('#f-repeat').checked ? 'weekly' : 'none',
    reminderMin: rem === '' ? null : Number(rem),
  };
  if (id) {
    const ev = db.events.find(x => x.id === id);
    if (ev.date !== data.date) { ev.exceptions = {}; ev.sessionNotes = {}; }
    Object.assign(ev, data);
  } else {
    db.events.push({ id: uid(), note: '', exceptions: {}, sessionNotes: {}, ...data });
  }
  save(); closeDialog(); render();
}

function occDialog(key) {
  const [id, orig] = key.split('@');
  const ev = db.events.find(x => x.id === id);
  if (!ev) return;
  const o = occurrences(orig, addDays(orig, 400)).find(x => x.ev.id === id && x.orig === orig);
  const ex = (ev.exceptions || {})[orig];
  const cur = o || { date: orig, time: ev.time };
  const note = (ev.sessionNotes || {})[orig] || '';
  openDialog(`
    <h3>${esc(ev.title)}</h3>
    <p class="muted">${esc(fmtDay(cur.date))}${cur.time ? ' à ' + esc(cur.time) : ''}${ev.place ? ' · ' + esc(ev.place) : ''}${ex && ex.cancelled ? ' — <b>annulée</b>' : ''}</p>
    <label>Notes de la séance</label><textarea id="o-note" placeholder="Ce que le prof a dit, à revoir, morceau travaillé…">${esc(note)}</textarea>
    <div class="actions"><button class="btn" data-act="save-note" data-key="${key}">Enregistrer la note</button></div>
    <h2>Cette séance uniquement</h2>
    <div class="actions">
      ${ex && ex.cancelled || ex && ex.moveTo
        ? `<button class="btn sec" data-act="restore" data-key="${key}">Rétablir</button>`
        : `<button class="btn danger" data-act="cancel-occ" data-key="${key}">Annuler cette séance</button>`}
    </div>
    <label>Déplacer à</label>
    <div class="actions" style="margin-top:0"><input type="date" id="o-date" value="${cur.date}" style="flex:1"><input type="time" id="o-time" value="${cur.time || ''}" style="flex:1">
    <button class="btn sec" data-act="move-occ" data-key="${key}">Déplacer</button></div>
    <div class="actions"><button class="btn sec" data-act="edit-event" data-id="${id}">Modifier la série</button><button class="btn sec right" data-act="close">Fermer</button></div>`);
}

function hwForm() {
  openDialog(`
    <h3>Nouveau devoir</h3>
    <label>Devoir</label><input type="text" id="h-title" placeholder="Exercices page 42">
    <label>Matière</label><select id="h-subject">${subjectOptions('chinois')}</select>
    <label>À rendre</label>
    <select id="h-mode"><option value="next">Pour la prochaine séance</option><option value="date">À une date précise</option><option value="none">Sans date limite</option></select>
    <div id="h-datewrap" hidden><label>Date limite</label><input type="date" id="h-date" value="${addDays(today(), 1)}"></div>
    <div class="actions"><button class="btn" data-act="save-hw">Ajouter</button><button class="btn sec" data-act="close">Fermer</button></div>`);
  $('#h-mode').addEventListener('change', e => { $('#h-datewrap').hidden = e.target.value !== 'date'; });
}

function saveHw() {
  const title = $('#h-title').value.trim();
  if (!title) { alert('Écris le devoir.'); return; }
  const mode = $('#h-mode').value;
  db.homework.push({
    id: uid(), title, subjectId: $('#h-subject').value, created: today(),
    due: mode === 'date' ? $('#h-date').value : null, dueNext: mode === 'next', done: false, doneAt: null,
  });
  save(); closeDialog(); render();
}

function practiceDialog() {
  openDialog(`
    <h3>Pratique du violon</h3>
    <label>Minutes (facultatif)</label><input type="text" inputmode="numeric" id="p-min" placeholder="30">
    <div class="actions"><button class="btn" data-act="save-practice">Valider</button><button class="btn sec" data-act="close">Fermer</button></div>`);
}

/* ---------- Actions ---------- */
function setException(key, value, note) {
  const [id, orig] = key.split('@');
  const ev = db.events.find(x => x.id === id);
  ev.exceptions = ev.exceptions || {};
  if (value === null) delete ev.exceptions[orig]; else ev.exceptions[orig] = value;
  save(); closeDialog(); render();
}

const actions = {
  close: closeDialog,
  'save-event': b => saveEvent(b.dataset.id),
  'edit-event': b => eventForm(db.events.find(x => x.id === b.dataset.id)),
  'delete-event': b => { if (confirm('Supprimer toute la série ?')) { db.events = db.events.filter(x => x.id !== b.dataset.id); save(); closeDialog(); render(); } },
  'cancel-occ': b => setException(b.dataset.key, { cancelled: true }),
  restore: b => setException(b.dataset.key, null),
  'move-occ': b => {
    const date = $('#o-date').value, time = $('#o-time').value;
    if (!date) return;
    setException(b.dataset.key, { moveTo: { date, time } });
  },
  'save-note': b => {
    const [id, orig] = b.dataset.key.split('@');
    const ev = db.events.find(x => x.id === id);
    ev.sessionNotes = ev.sessionNotes || {};
    const v = $('#o-note').value.trim();
    if (v) ev.sessionNotes[orig] = v; else delete ev.sessionNotes[orig];
    save(); closeDialog();
  },
  'save-hw': saveHw,
  'clear-done': () => { if (confirm('Supprimer les devoirs terminés ?')) { db.homework = db.homework.filter(h => !h.done); save(); render(); } },
  practice: practiceDialog,
  'save-practice': () => {
    const m = parseInt($('#p-min').value, 10);
    db.practice[today()] = { minutes: Number.isFinite(m) && m > 0 ? m : null };
    save(); closeDialog(); render();
  },
  unpractice: () => { delete db.practice[today()]; save(); render(); },
  export: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' }));
    a.download = `agenda-sauvegarde-${today()}.json`;
    a.click();
  },
  import: () => $('#importFile').click(),
};

document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act && actions[act.dataset.act]) { actions[act.dataset.act](act); return; }
  if (e.target.closest('[data-check]')) return; // géré par 'change'
  const occ = e.target.closest('[data-occ]');
  if (occ) { occDialog(occ.dataset.occ); return; }
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#fab')) { tab === 'homework' ? hwForm() : eventForm(null); }
});

document.addEventListener('change', e => {
  const chk = e.target.closest('[data-check]');
  if (chk) {
    const h = db.homework.find(x => x.id === chk.dataset.check);
    h.done = chk.checked; h.doneAt = chk.checked ? new Date().toISOString() : null;
    save(); render(); return;
  }
  const set = e.target.closest('[data-set]');
  if (set) {
    db.settings[set.dataset.set] = set.type === 'checkbox' ? set.checked : set.value;
    save(); return;
  }
  if (e.target.id === 'importFile' && e.target.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data.events) || !Array.isArray(data.homework)) throw new Error('format');
        if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) return;
        db = Object.assign(DEFAULTS(), data); save(); render();
      } catch (err) { alert('Fichier de sauvegarde invalide.'); }
    };
    r.readAsText(e.target.files[0]);
  }
});

/* ---------- Démarrage ---------- */
render();
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
