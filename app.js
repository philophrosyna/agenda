import { ymd, parse, addDays, DEFAULT_SETTINGS, live, occurrences, nextSessionDate, hwDue, mergeDb } from './shared.js';
import { API_URL, VAPID_PUBLIC_KEY } from './config.js';

/* ---------- Données ---------- */
const KEY = 'appcal.v1';
const CODE_KEY = 'appcal.code';
const DEFAULTS = () => ({
  subjects: [
    { id: 'chinois', name: 'Chinois', color: '#e0483e' },
    { id: 'violon', name: 'Violon', color: '#7b4fd6' },
    { id: 'autre', name: 'Autre', color: '#2f8f6f' },
  ],
  events: [],     // {id, title, subjectId, date, time, place, repeat:'none'|'weekly', reminderMin, exceptions:{[date]:{cancelled}|{moveTo:{date,time}}}, sessionNotes:{[date]:text}, updatedAt, deleted?}
  homework: [],   // {id, title, subjectId, due:'YYYY-MM-DD'|null, dueNext:boolean, created, done, doneAt, updatedAt, deleted?}
  practice: {},   // {[date]: {minutes:number|null, updatedAt, deleted?}}
  settings: { ...DEFAULT_SETTINGS },
});

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = Object.assign(DEFAULTS(), JSON.parse(raw));
      const now = Date.now();
      [...d.events, ...d.homework, ...Object.values(d.practice)].forEach(r => { if (!r.updatedAt) r.updatedAt = now; });
      return d;
    }
  } catch (e) { /* stockage indisponible */ }
  return DEFAULTS();
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
}
const touch = r => { r.updatedAt = Date.now(); return r; };
function save() { saveLocal(); scheduleSync(); }

/* ---------- Utilitaires ---------- */
const $ = s => document.querySelector(s);
const today = () => ymd(new Date());
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subject = id => db.subjects.find(s => s.id === id) || db.subjects[db.subjects.length - 1];
const fmtDay = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const occ = (from, to) => occurrences(db, from, to);
const due = h => hwDue(db, h);
const pendingHw = () => live(db.homework).filter(h => !h.done);
const practiced = d => !!db.practice[d] && !db.practice[d].deleted;

function hwBadge(h) {
  if (h.done) return '';
  const d = due(h);
  if (!d) return h.dueNext ? '<span class="badge">prochain cours</span>' : '';
  const t = today();
  if (d < t) return '<span class="badge late">en retard</span>';
  if (d === t) return '<span class="badge soon">aujourd\'hui</span>';
  if (d === addDays(t, 1)) return '<span class="badge soon">demain</span>';
  return `<span class="badge">${esc(fmtShort(d))}</span>`;
}

function practiceStreak() {
  let d = today();
  if (!practiced(d)) d = addDays(d, -1); // la série reste valable tant que la journée n'est pas finie
  let n = 0;
  while (practiced(d)) { n++; d = addDays(d, -1); }
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

const byDue = (a, b) => (due(a) || '9').localeCompare(due(b) || '9');

function viewToday() {
  const t = today();
  const list = occ(t, t);
  const pending = pendingHw();
  const bySubject = {};
  pending.forEach(h => (bySubject[h.subjectId] = bySubject[h.subjectId] || []).push(h));
  const p = practiced(t) ? db.practice[t] : null;
  const streak = practiceStreak();
  return `
    <h2>${esc(fmtDay(t))}</h2>
    <div class="card">${list.length ? list.map(occRow).join('') : '<div class="empty">Rien de prévu aujourd\'hui.</div>'}</div>
    <h2>Devoirs restants</h2>
    <div class="card">${pending.length
      ? Object.values(bySubject).map(l => l.sort(byDue).map(hwRow).join('')).join('')
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
  const list = occ(t, addDays(t, 60));
  if (!list.length) return '<div class="card"><div class="empty">Aucun événement dans les 60 prochains jours. Appuie sur + pour en ajouter.</div></div>';
  const days = {};
  list.forEach(o => (days[o.date] = days[o.date] || []).push(o));
  return Object.keys(days).sort().map(d =>
    `<div class="daytitle ${d === t ? 'today' : ''}">${esc(fmtDay(d))}</div><div class="card">${days[d].map(occRow).join('')}</div>`).join('');
}

function viewHomework() {
  const pending = pendingHw().sort(byDue);
  const done = live(db.homework).filter(h => h.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 15);
  return `
    <h2>À faire</h2>
    <div class="card">${pending.length ? pending.map(hwRow).join('') : '<div class="empty">Aucun devoir en attente.</div>'}</div>
    ${done.length ? `<h2>Terminés</h2><div class="card">${done.map(hwRow).join('')}</div>
    <div class="actions"><button class="btn sec small" data-act="clear-done">Vider les terminés</button></div>` : ''}`;
}

/* ---------- Synchronisation ---------- */
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } };
const setCode = v => { try { v ? localStorage.setItem(CODE_KEY, v) : localStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ } };

let syncMsg = '';
let syncing = false, syncAgain = false, syncTimer = null;
let pushState = 'unknown'; // unsupported | off | on | unknown

class AuthError extends Error {}

async function api(path, body) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getCode(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

function scheduleSync() {
  if (!getCode()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 1500);
}

async function sync() {
  if (!getCode() || !API_URL) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const { data } = await api('/api/sync', { data: db });
    const before = JSON.stringify(db);
    db = mergeDb(db, data);
    if (JSON.stringify(db) !== before) { saveLocal(); render(); }
    const d = new Date();
    syncMsg = `Synchronisé à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) {
    if (e instanceof AuthError) { setCode(''); syncMsg = 'Code d\'accès refusé.'; }
    else syncMsg = 'Hors connexion (les données sont gardées sur cet appareil).';
  } finally {
    syncing = false;
    if (tab === 'settings') render();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

/* ---------- Notifications (Web Push) ---------- */
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

async function refreshPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { pushState = 'unsupported'; return; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    pushState = sub && Notification.permission === 'granted' ? 'on' : 'off';
    if (pushState === 'on' && getCode()) api('/api/subscribe', { subscription: sub.toJSON() }).catch(() => {});
  } catch (e) { pushState = 'off'; }
  if (tab === 'settings') render();
}

async function enablePush() {
  if (pushState === 'unsupported') { alert('Les notifications ne sont pas disponibles ici. Sur iPhone, ouvre l\'appli depuis son icône sur l\'écran d\'accueil.'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Notifications refusées. Tu peux les autoriser dans Réglages iPhone > Notifications > Agenda.'); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    await api('/api/subscribe', { subscription: sub.toJSON() });
    pushState = 'on';
  } catch (e) {
    alert('Impossible d\'activer les notifications : ' + (e.message || e));
  }
  render();
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) { await api('/api/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  } catch (e) { /* ignore */ }
  pushState = 'off';
  render();
}

async function testPush() {
  try {
    const r = await api('/api/test');
    if (!r.subscriptions) alert('Aucun appareil enregistré. Active d\'abord les notifications.');
    else if (!r.sent) alert('Envoi échoué. Réessaie dans un instant.');
  } catch (e) { alert('Serveur injoignable.'); }
}

/* ---------- Réglages ---------- */
function viewSettings() {
  const s = db.settings;
  const connected = !!getCode();
  const time = (k, label) => `<div class="setrow"><span>${label}</span><input type="time" data-set="${k}" value="${s[k]}"></div>`;
  const sync = connected
    ? `<div class="setrow"><span>Connecté ✓</span><button class="btn sec small" data-act="logout">Déconnecter</button></div>
       <div class="note">${esc(syncMsg || 'Synchronisation en cours…')}</div>`
    : `<div class="note">Entre ton code d'accès pour synchroniser tes appareils et recevoir les notifications.${syncMsg ? '<br><b>' + esc(syncMsg) + '</b>' : ''}</div>
       <div class="setrow"><input type="password" id="codeInput" placeholder="Code d'accès" autocomplete="off" style="flex:1;margin-right:8px"><button class="btn small" data-act="login">Connexion</button></div>`;
  let notif = '';
  if (connected) {
    if (pushState === 'on') {
      notif = `<div class="setrow"><span>Notifications activées ✓</span><button class="btn sec small" data-act="push-test">Tester</button></div>
        <div class="setrow"><span>Désactiver sur cet appareil</span><button class="btn sec small" data-act="push-off">Désactiver</button></div>`;
    } else if (pushState === 'unsupported' || (/iPhone|iPad/.test(navigator.userAgent) && !isStandalone())) {
      notif = '<div class="note">Sur iPhone, ajoute d\'abord l\'appli à l\'écran d\'accueil (Safari > Partager > Sur l\'écran d\'accueil), puis ouvre-la depuis son icône pour activer les notifications.</div>';
    } else {
      notif = '<div class="setrow"><span>Notifications</span><button class="btn small" data-act="push-on">Activer</button></div>';
    }
  }
  return `
    <h2>Synchronisation</h2>
    <div class="card">${sync}</div>
    ${connected ? `<h2>Notifications</h2><div class="card">${notif}</div>` : ''}
    <h2>Horaires des notifications</h2>
    <div class="card">
      ${time('morning', 'Récap du matin')}
      ${time('weekly', 'Récap du lundi')}
      ${time('homework', 'Rappel des devoirs')}
      <div class="setrow"><span>Notif du soir (devoirs restants)</span><input type="checkbox" class="chk" data-set="eveningOn" ${s.eveningOn ? 'checked' : ''}></div>
      ${time('evening', 'Heure de la notif du soir')}
      <div class="note">Heure de Paris. Le rappel avant un cours se règle sur chaque événement.</div>
    </div>
    <h2>Sauvegarde</h2>
    <div class="card"><div class="setrow"><span>Exporter mes données</span><button class="btn sec small" data-act="export">Exporter</button></div>
    <div class="setrow"><span>Importer une sauvegarde</span><button class="btn sec small" data-act="import">Importer</button></div></div>
    <input type="file" id="importFile" accept="application/json" hidden>`;
}

function updateBadge() {
  try {
    const n = pendingHw().length;
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
  const e = ev || { title: '', subjectId: 'chinois', date: today(), time: '18:00', place: '', repeat: 'none', reminderMin: 60 };
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
    Object.assign(ev, data); touch(ev);
  } else {
    db.events.push(touch({ id: uid(), exceptions: {}, sessionNotes: {}, ...data }));
  }
  save(); closeDialog(); render();
}

function occDialog(key) {
  const [id, orig] = key.split('@');
  const ev = db.events.find(x => x.id === id && !x.deleted);
  if (!ev) return;
  const o = occ(orig, addDays(orig, 400)).find(x => x.ev.id === id && x.orig === orig);
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
      ${ex && (ex.cancelled || ex.moveTo)
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
  db.homework.push(touch({
    id: uid(), title, subjectId: $('#h-subject').value, created: today(),
    due: mode === 'date' ? $('#h-date').value : null, dueNext: mode === 'next', done: false, doneAt: null,
  }));
  save(); closeDialog(); render();
}

function practiceDialog() {
  openDialog(`
    <h3>Pratique du violon</h3>
    <label>Minutes (facultatif)</label><input type="text" inputmode="numeric" id="p-min" placeholder="30">
    <div class="actions"><button class="btn" data-act="save-practice">Valider</button><button class="btn sec" data-act="close">Fermer</button></div>`);
}

/* ---------- Actions ---------- */
function setException(key, value) {
  const [id, orig] = key.split('@');
  const ev = db.events.find(x => x.id === id);
  ev.exceptions = ev.exceptions || {};
  if (value === null) delete ev.exceptions[orig]; else ev.exceptions[orig] = value;
  touch(ev); save(); closeDialog(); render();
}

const actions = {
  close: closeDialog,
  'save-event': b => saveEvent(b.dataset.id),
  'edit-event': b => eventForm(db.events.find(x => x.id === b.dataset.id)),
  'delete-event': b => {
    if (!confirm('Supprimer toute la série ?')) return;
    touch(Object.assign(db.events.find(x => x.id === b.dataset.id), { deleted: true }));
    save(); closeDialog(); render();
  },
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
    touch(ev); save(); closeDialog();
  },
  'save-hw': saveHw,
  'clear-done': () => {
    if (!confirm('Supprimer les devoirs terminés ?')) return;
    live(db.homework).filter(h => h.done).forEach(h => touch(Object.assign(h, { deleted: true })));
    save(); render();
  },
  practice: practiceDialog,
  'save-practice': () => {
    const m = parseInt($('#p-min').value, 10);
    db.practice[today()] = touch({ minutes: Number.isFinite(m) && m > 0 ? m : null });
    save(); closeDialog(); render();
  },
  unpractice: () => { db.practice[today()] = touch({ deleted: true }); save(); render(); },
  login: () => {
    const v = ($('#codeInput').value || '').trim();
    if (!v) return;
    setCode(v); syncMsg = 'Connexion…'; render();
    sync().then(() => refreshPushState());
  },
  logout: () => { setCode(''); syncMsg = ''; render(); },
  'push-on': enablePush,
  'push-off': disablePush,
  'push-test': testPush,
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
  const o = e.target.closest('[data-occ]');
  if (o) { occDialog(o.dataset.occ); return; }
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (e.target.closest('#fab')) { tab === 'homework' ? hwForm() : eventForm(null); }
});

document.addEventListener('change', e => {
  const chk = e.target.closest('[data-check]');
  if (chk) {
    const h = db.homework.find(x => x.id === chk.dataset.check);
    h.done = chk.checked; h.doneAt = chk.checked ? new Date().toISOString() : null;
    touch(h); save(); render(); return;
  }
  const set = e.target.closest('[data-set]');
  if (set) {
    db.settings[set.dataset.set] = set.type === 'checkbox' ? set.checked : set.value;
    touch(db.settings); save(); return;
  }
  if (e.target.id === 'importFile' && e.target.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!Array.isArray(data.events) || !Array.isArray(data.homework)) throw new Error('format');
        if (!confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) return;
        // Les données importées reçoivent la date du jour pour l'emporter à la synchro.
        const now = Date.now();
        [...(data.events || []), ...(data.homework || []), ...Object.values(data.practice || {})].forEach(x => { x.updatedAt = now; });
        // Ce qui n'est pas dans la sauvegarde est marqué supprimé.
        for (const k of ['events', 'homework']) {
          const keep = new Set(data[k].map(x => x.id));
          live(db[k]).filter(x => !keep.has(x.id)).forEach(x => data[k].push({ ...x, deleted: true, updatedAt: now }));
        }
        db = Object.assign(DEFAULTS(), data); db.settings = touch({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
        save(); render();
      } catch (err) { alert('Fichier de sauvegarde invalide.'); }
    };
    r.readAsText(e.target.files[0]);
  }
});

/* ---------- Démarrage ---------- */
render();
sync();
refreshPushState();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); sync(); } });
setInterval(() => { if (!document.hidden) sync(); }, 60000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
