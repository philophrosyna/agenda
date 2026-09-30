import {
  ymd, parse, addDays, daysBetween, weekStart, DEFAULT_SETTINGS, live, occurrences, isRepeat, hwDue, mergeDb,
  evReminders, recurDue, recurDone, pendingHomework, practiced, minutesOn, currentStreak, bestStreak, weekPracticeDays,
} from './shared.js';
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
  // {id, title, subjectId, date, endDate?, time ('' = toute la journée), place, repeat:'none'|'daily'|'weekly'|'biweekly'|'monthly'|'yearly', until?, reminders:[min],
  //  exceptions:{[date]:{cancelled}|{moveTo:{date,time}}}, sessionNotes:{[date]:text}, updatedAt, deleted?}
  events: [],
  // {id, title, subjectId, due|null, dueNext, created, done, doneAt, recur?:{days:[0..6]}, doneOn?:{[date]:ts}, updatedAt, deleted?}
  homework: [],
  practice: {},   // {[date]: {minutes:number|null, updatedAt, deleted?}}
  settings: { ...DEFAULT_SETTINGS },
});

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = Object.assign(DEFAULTS(), JSON.parse(raw));
      d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
      const now = Date.now();
      [...d.subjects, ...d.events, ...d.homework, ...Object.values(d.practice)].forEach(r => { if (!r.updatedAt) r.updatedAt = now; });
      return d;
    }
  } catch (e) { /* stockage indisponible */ }
  return DEFAULTS();
}
function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
}
const touch = r => { r.updatedAt = Date.now(); return r; };
function save() { saveLocal(); dirty = true; scheduleSync(); }

/* ---------- Utilitaires ---------- */
const $ = s => document.querySelector(s);
const today = () => ymd(new Date());
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const subjects = () => live(db.subjects);
const NO_SUBJECT = { id: '', name: '', color: '#8e8e93' };  // événement sans matière (pas un cours)
const subject = id => !id ? NO_SUBJECT : subjects().find(s => s.id === id) || subjects()[subjects().length - 1] || { id: '?', name: '?', color: '#888' };
const fmtDay = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
// Heure de fin par défaut : une heure après le début (vide si ça dépasserait minuit).
const plusHour = t => { const [h, m] = (t || '').split(':').map(Number); return Number.isFinite(h) && h < 23 ? `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}` : ''; };
const timeSpan = (t, ev) => t ? t + (ev.endTime && ev.endTime > t ? '–' + ev.endTime : '') : '';
const fmtShort = s => parse(s).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const occ = (from, to) => occurrences(db, from, to);
const due = h => hwDue(db, h);
const WD = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];      // index = getDay()
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];              // affichage lundi d'abord

const pending = () => pendingHomework(db, today());
const pendingCount = () => { const p = pending(); return p.oneOff.length + p.recurring.length; };

function hwBadge(h) {
  if (h.recur) {
    const days = h.recur.days;
    return `<span class="badge">${days.length === 7 ? 'chaque jour' : WD_ORDER.filter(d => days.includes(d)).map(d => WD[d]).join(' ')}</span>`;
  }
  if (h.done) return '';
  const d = due(h);
  if (!d) return h.dueNext ? '<span class="badge">prochain cours</span>' : '';
  const t = today();
  if (d < t) return '<span class="badge late">en retard</span>';
  if (d === t) return '<span class="badge soon">aujourd\'hui</span>';
  if (d === addDays(t, 1)) return '<span class="badge soon">demain</span>';
  return `<span class="badge">${esc(fmtShort(d))}</span>`;
}

/* ---------- Rendu ---------- */
let tab = 'today';
let mode = 'list';                     // agenda : 'list' | 'month'
let month = today().slice(0, 7);       // 'YYYY-MM'
let selDay = today();
let noteFilter = 'all';
const TITLES = { today: "Aujourd'hui", agenda: 'Agenda', homework: 'Devoirs', notes: 'Notes', settings: 'Réglages' };
const VIEWS = () => ({ today: viewToday, agenda: viewAgenda, homework: viewHomework, notes: viewNotes, settings: viewSettings });

function render() {
  $('#title').textContent = TITLES[tab];
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#fab').classList.toggle('hidden', tab === 'settings' || tab === 'notes');
  $('#view').innerHTML = VIEWS()[tab]();
  updateBadge();
}

function occRow(o) {
  const s = subject(o.ev.subjectId);
  const meta = [timeSpan(o.time, o.ev) || (o.days > 1 ? '' : 'Toute la journée'), o.ev.place].filter(Boolean).join(' · ');
  const tag = o.cancelled ? '<span class="badge late">annulé</span>'
    : o.moved ? '<span class="badge soon">déplacé</span>'
    : o.days > 1 ? `<span class="badge">jour ${o.day}/${o.days}</span>` : '';
  return `<div class="row ${o.cancelled ? 'cancelled' : ''}" data-occ="${o.ev.id}@${o.orig}">
    <span class="dot" style="background:${s.color}"></span>
    <div class="grow"><b>${esc(o.ev.title)}</b><small>${esc(meta || s.name)}</small></div>${tag}</div>`;
}

function hwRow(h, forToday) {
  const s = subject(h.subjectId);
  const checked = h.recur ? recurDone(h, today()) : h.done;
  const checkable = !h.recur || recurDue(h, today());
  return `<div class="row ${checked ? 'done' : ''}" data-hw="${h.id}">
    ${checkable ? `<input type="checkbox" class="chk" ${h.recur ? 'data-checkrec' : 'data-check'}="${h.id}" ${checked ? 'checked' : ''}>` : '<span style="width:24px;flex:none"></span>'}
    <div class="grow"><b>${esc(h.title)}</b><small><span class="dot" style="background:${s.color};display:inline-block"></span> ${esc(s.name)}</small></div>${hwBadge(h)}</div>`;
}

const byDue = (a, b) => (due(a) || '9').localeCompare(due(b) || '9');

// Prochain cours (séance avec heure, non annulée) et devoirs à rendre ce jour-là dans la même matière.
function nextClassCard() {
  const t = today();
  const hhmm = new Date().toTimeString().slice(0, 5);
  const o = occ(t, addDays(t, 30)).find(x => !x.cancelled && isCourse(x.ev.subjectId) && x.day === 1 && x.time && (x.date > t || x.time >= hhmm));
  if (!o) return '';
  const n = daysBetween(t, o.date);
  const when = n === 0 ? "aujourd'hui" : n === 1 ? 'demain' : `dans ${n} j`;
  const s = subject(o.ev.subjectId);
  const hws = pending().oneOff.filter(h => h.subjectId === o.ev.subjectId && due(h) === o.date);
  return `<h2>Prochain cours</h2><div class="card">
    <div class="row" data-occ="${o.ev.id}@${o.orig}"><span class="dot" style="background:${s.color}"></span>
      <div class="grow"><b>${esc(o.ev.title)}</b><small>${esc(fmtDay(o.date))} à ${esc(timeSpan(o.time, o.ev))}</small></div><span class="badge soon">${when}</span></div>
    ${hws.map(h => hwRow(h)).join('')}</div>`;
}

// Échéances marquées « compte à rebours » (la prochaine occurrence de chaque événement).
function countdownCard() {
  const t = today(), seen = new Set(), list = [];
  for (const o of occ(t, addDays(t, 365))) {
    if (!o.ev.countdown || o.cancelled || o.day !== 1 || seen.has(o.ev.id)) continue;
    seen.add(o.ev.id); list.push(o);
  }
  if (!list.length) return '';
  return `<h2>Échéances</h2><div class="card">${list.slice(0, 5).map(o => {
    const n = daysBetween(t, o.date);
    return `<div class="row" data-occ="${o.ev.id}@${o.orig}"><span class="dot" style="background:${subject(o.ev.subjectId).color}"></span>
      <div class="grow"><b>${esc(o.ev.title)}</b><small>${esc(fmtDay(o.date))}${o.time ? ' à ' + esc(o.time) : ''}</small></div>
      <span class="badge ${n <= 3 ? 'late' : n <= 7 ? 'soon' : ''}" style="font-size:14px">${n === 0 ? "Aujourd'hui" : 'J-' + n}</span></div>`;
  }).join('')}</div>`;
}

function viewToday() {
  const t = today();
  const list = occ(t, t);
  const { oneOff, recurring } = pending();
  const all = [...oneOff.sort(byDue), ...recurring];
  const bySubject = {};
  all.forEach(h => (bySubject[h.subjectId] = bySubject[h.subjectId] || []).push(h));
  const p = practiced(db, t) ? db.practice[t] : null;
  const streak = currentStreak(db, t);
  const goal = db.settings.practiceGoal;
  const goalLine = goal > 0 ? `<small>Cette semaine : ${weekPracticeDays(db, t)}/${goal} jours</small>` : '<small>de pratique d\'affilée</small>';
  return `
    <h2>${esc(fmtDay(t))}</h2>
    <div class="card">${list.length ? list.map(occRow).join('') : '<div class="empty">Rien de prévu aujourd\'hui.</div>'}</div>
    ${nextClassCard()}${countdownCard()}
    <h2>Devoirs restants</h2>
    <div class="card">${all.length
      ? Object.values(bySubject).map(l => l.map(h => hwRow(h)).join('')).join('')
      : '<div class="empty">Aucun devoir en attente. 🎉</div>'}</div>
    <h2>Violon</h2>
    <div class="card practice">
      <div class="grow"><div class="streak">${streak} jour${streak > 1 ? 's' : ''}</div>${goalLine}${goal > 0 ? '<br><small>de pratique d\'affilée : ' + streak + '</small>' : ''}</div>
      <button class="btn sec small" data-act="stats">Stats</button>
      ${p ? `<button class="btn sec small" data-act="unpractice">Pratiqué ✓${p.minutes ? ' · ' + p.minutes + ' min' : ''}</button>`
          : '<button class="btn" data-act="practice">J\'ai pratiqué</button>'}
    </div>
    <div class="actions"><button class="btn sec small" data-act="practice-yday">${practiced(db, addDays(t, -1)) ? 'Hier pratiqué ✓ (retirer)' : "Ajouter l'entraînement d'hier"}</button></div>`;
}

/* ----- Agenda : liste et mois ----- */
function viewAgenda() {
  const seg = `<div class="seg"><button data-mode="list" class="${mode === 'list' ? 'on' : ''}">Liste</button><button data-mode="month" class="${mode === 'month' ? 'on' : ''}">Mois</button></div>`;
  return seg + (mode === 'month' ? monthView() : listView());
}

function listView() {
  const t = today();
  const list = occ(t, addDays(t, 60));
  if (!list.length) return '<div class="card" style="margin-top:12px"><div class="empty">Aucun événement dans les 60 prochains jours. Appuie sur + pour en ajouter.</div></div>';
  const days = {};
  list.forEach(o => (days[o.date] = days[o.date] || []).push(o));
  return Object.keys(days).sort().map(d =>
    `<div class="daytitle ${d === t ? 'today' : ''}">${esc(fmtDay(d))}</div><div class="card">${days[d].map(occRow).join('')}</div>`).join('');
}

function monthView() {
  const first = `${month}-01`;
  const offset = (parse(first).getDay() + 6) % 7;
  const start = addDays(first, -offset);
  const end = addDays(start, 41);
  const byDay = {};
  occ(start, end).filter(o => !o.cancelled).forEach(o => (byDay[o.date] = byDay[o.date] || []).push(o));
  const t = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const colors = [...new Set((byDay[d] || []).map(o => subject(o.ev.subjectId).color))].slice(0, 4);
    cells += `<button class="cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === t ? 'today' : ''} ${d === selDay ? 'sel' : ''}" data-day="${d}">
      <span>${parse(d).getDate()}</span><div class="dots">${colors.map(c => `<i style="background:${c}"></i>`).join('')}</div></button>`;
  }
  const title = parse(first).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const dayOcc = occ(selDay, selDay);
  return `
    <div class="monthbar"><button data-nav="-1">‹</button><b>${esc(title)}</b><button data-nav="1">›</button></div>
    <div class="grid7">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(x => `<div class="wd">${x}</div>`).join('')}${cells}</div>
    <div class="daytitle ${selDay === t ? 'today' : ''}">${esc(fmtDay(selDay))}</div>
    <div class="card">${dayOcc.length ? dayOcc.map(occRow).join('') : '<div class="empty">Rien ce jour-là.</div>'}</div>
    <div class="actions"><button class="btn sec small" data-act="add-on-day">+ Ajouter ce jour</button><button class="btn sec small" data-act="month-today">Aujourd'hui</button></div>`;
}

/* ----- Devoirs ----- */
function viewHomework() {
  const t = today();
  const all = live(db.homework);
  const oneOff = all.filter(h => !h.recur && !h.done).sort(byDue);
  const recur = all.filter(h => h.recur);
  const done = all.filter(h => !h.recur && h.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 15);
  return `
    <h2>À faire</h2>
    <div class="card">${oneOff.length ? oneOff.map(h => hwRow(h)).join('') : '<div class="empty">Aucun devoir en attente.</div>'}</div>
    ${recur.length ? `<h2>Récurrents</h2><div class="card">${recur.map(h => hwRow(h)).join('')}</div>` : ''}
    ${done.length ? `<h2>Terminés</h2><div class="card">${done.map(h => hwRow(h)).join('')}</div>
    <div class="actions"><button class="btn sec small" data-act="clear-done">Vider les terminés</button></div>` : ''}`;
}

/* ----- Notes de séance (historique par matière) ----- */
function allNotes() {
  const out = [];
  for (const ev of live(db.events)) {
    for (const [date, text] of Object.entries(ev.sessionNotes || {})) out.push({ ev, date, text });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function noteRow(n) {
  const s = subject(n.ev.subjectId);
  return `<div class="row" data-occ="${n.ev.id}@${n.date}" style="align-items:flex-start">
    <span class="dot" style="background:${s.color};margin-top:7px"></span>
    <div class="grow"><b>${esc(n.ev.title)}</b><small>${esc(fmtDay(n.date))}</small><div class="notetext">${esc(n.text)}</div></div></div>`;
}

function viewNotes() {
  const chips = [['all', 'Toutes'], ...subjects().map(s => [s.id, s.name])]
    .map(([id, name]) => `<button class="chip ${noteFilter === id ? 'on' : ''}" data-notefilter="${id}">${esc(name)}</button>`).join('');
  const list = allNotes().filter(n => noteFilter === 'all' || n.ev.subjectId === noteFilter);
  return `<div class="chips">${chips}</div>
    <div class="card">${list.length ? list.map(noteRow).join('') : '<div class="empty">Aucune note. Ouvre une séance dans l\'agenda pour en écrire une.</div>'}</div>`;
}

/* ---------- Synchronisation ---------- */
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } };
const setCode = v => { try { v ? localStorage.setItem(CODE_KEY, v) : localStorage.removeItem(CODE_KEY); } catch (e) { /* ignore */ } };

let syncMsg = '';
let syncing = false, syncAgain = false, syncTimer = null;
let serverRev = null;  // dernière version du serveur connue
let dirty = true;      // modifications locales pas encore envoyées
let pushState = 'unknown'; // unsupported | off | on | unknown

class AuthError extends Error {}
class RateError extends Error {}

async function api(path, body) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getCode(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 401) throw new AuthError();
  if (res.status === 429) throw new RateError();
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
  const sending = dirty;
  dirty = false;
  try {
    const r = await api('/api/sync', { rev: serverRev, data: sending || serverRev === null ? db : undefined });
    serverRev = r.rev;
    if (r.data) adopt(mergeDb(db, r.data));
    const d = new Date();
    syncMsg = `Synchronisé à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) {
    dirty = dirty || sending;
    if (e instanceof AuthError) { setCode(''); syncMsg = 'Code d\'accès refusé.'; }
    else if (e instanceof RateError) syncMsg = 'Trop d\'essais : réessaie dans 15 minutes.';
    else syncMsg = 'Hors connexion (les données sont gardées sur cet appareil).';
  } finally {
    syncing = false;
    renderIfSettings();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

// Ne redessine les réglages que si tu n'es pas en train de saisir quelque chose.
function renderIfSettings() {
  if (tab !== 'settings') return;
  const a = document.activeElement;
  if (a && a.matches && a.matches('input,select,textarea')) return;
  render();
}

function adopt(next) {
  const before = JSON.stringify(db);
  db = next;
  if (JSON.stringify(db) !== before) { saveLocal(); render(); }
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
  renderIfSettings();
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
  fetchStatus();
}

let notifStatus = null;
async function fetchStatus() {
  if (!getCode()) return;
  try { notifStatus = await api('/api/status'); } catch (e) { notifStatus = null; }
  renderIfSettings();
}

function statusLine() {
  if (!notifStatus) return 'Dernier envoi : inconnu';
  const l = notifStatus.lastSend;
  if (!l) return "Aucun envoi pour l'instant";
  const d = new Date(l.at);
  const day = ymd(d) === today() ? "aujourd'hui" : fmtShort(ymd(d));
  return `Dernier envoi : ${day} à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (${l.title})`;
}

/* ---------- Réglages ---------- */
function viewSettings() {
  const s = db.settings;
  const connected = !!getCode();
  const time = (k, label) => `<div class="setrow"><span>${label}</span><input type="time" data-set="${k}" value="${s[k]}"></div>`;
  const syncCard = connected
    ? `<div class="setrow"><span>Connecté ✓</span><button class="btn sec small" data-act="logout">Déconnecter</button></div>
       <div class="note">${esc(syncMsg || 'Synchronisation en cours…')}</div>`
    : `<div class="note">Entre ton code d'accès pour synchroniser tes appareils et recevoir les notifications.${syncMsg ? '<br><b>' + esc(syncMsg) + '</b>' : ''}</div>
       <div class="setrow"><input type="password" id="codeInput" placeholder="Code d'accès" autocomplete="off" style="flex:1;margin-right:8px"><button class="btn small" data-act="login">Connexion</button></div>`;
  let notif = '';
  if (connected) {
    if (pushState === 'on') {
      notif = `<div class="setrow"><span>Notifications activées ✓</span><button class="btn sec small" data-act="push-test">Tester</button></div>
        <div class="note">${esc(statusLine())}</div>
        <div class="setrow"><span>Désactiver sur cet appareil</span><button class="btn sec small" data-act="push-off">Désactiver</button></div>`;
    } else if (pushState === 'unsupported' || (/iPhone|iPad/.test(navigator.userAgent) && !isStandalone())) {
      notif = '<div class="note">Sur iPhone, ajoute d\'abord l\'appli à l\'écran d\'accueil (Safari > Partager > Sur l\'écran d\'accueil), puis ouvre-la depuis son icône pour activer les notifications.</div>';
    } else {
      notif = '<div class="setrow"><span>Notifications</span><button class="btn small" data-act="push-on">Activer</button></div>';
    }
  }
  const goalOpts = [0, 1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}" ${n === s.practiceGoal ? 'selected' : ''}>${n ? n + ' jour' + (n > 1 ? 's' : '') + ' / semaine' : 'Aucun'}</option>`).join('');
  return `
    <h2>Synchronisation</h2>
    <div class="card">${syncCard}</div>
    ${connected ? `<h2>Notifications</h2><div class="card">${notif}</div>` : ''}
    <h2>Horaires des notifications</h2>
    <div class="card">
      ${time('morning', 'Récap du matin')}
      ${time('weekly', 'Récap du lundi')}
      ${time('homework', 'Rappel des devoirs')}
      <div class="setrow"><span>Notif du soir (devoirs restants)</span><input type="checkbox" class="chk" data-set="eveningOn" ${s.eveningOn ? 'checked' : ''}></div>
      ${time('evening', 'Heure de la notif du soir')}
      <div class="setrow"><span>Bilan du dimanche soir</span><input type="checkbox" class="chk" data-set="recapOn" ${s.recapOn ? 'checked' : ''}></div>
      ${time('recapTime', 'Heure du bilan')}
      <div class="note">Heure de Paris. Le rappel avant un cours se règle sur chaque événement.</div>
    </div>
    <h2>Matières et catégories</h2>
    <div class="card">
      ${subjects().map(x => `<div class="setrow"><input type="color" value="${x.color}" data-subcolor="${x.id}" style="width:44px;height:34px;padding:0;border:0;background:none;flex:none">
        <input type="text" value="${esc(x.name)}" data-subname="${x.id}" style="flex:1;margin:0 8px"><label class="inline" style="margin:0 8px 0 0;font-size:13px"><input type="checkbox" data-subcourse="${x.id}" ${x.course !== false ? 'checked' : ''}> cours</label><button class="btn sec small" data-act="del-subject" data-id="${x.id}">✕</button></div>`).join('')}
      <div class="setrow"><input type="text" id="newSubject" placeholder="Ex. Sorties, Boulot…" style="flex:1;margin-right:8px"><label class="inline" style="margin:0 8px 0 0;font-size:13px"><input type="checkbox" id="newCourse"> cours</label><button class="btn small" data-act="add-subject">Ajouter</button></div>
      <div class="note">« Cours » = matière avec devoirs et « Prochain cours ». Décoche pour une simple catégorie de couleur (sorties, boulot…).</div>
    </div>
    <h2>Objectif violon</h2>
    <div class="card">
      <div class="setrow"><span>Objectif de pratique</span><select data-set="practiceGoal" style="width:auto">${goalOpts}</select></div>
      ${time('goalTime', 'Rappel si tu es en retard')}
      <div class="note">Tu reçois une notification quand il ne reste plus de marge pour atteindre l'objectif de la semaine (lundi à dimanche).</div>
    </div>
    <h2>Sauvegardes</h2>
    <div class="card">
      ${connected ? `<div class="setrow"><span>Sauvegardes du serveur</span><button class="btn sec small" data-act="backups">Voir</button></div>
      <div class="note">Une copie est faite automatiquement chaque nuit et conservée 45 jours.</div>` : ''}
      <div class="setrow"><span>Exporter mes données</span><button class="btn sec small" data-act="export">Exporter</button></div>
      <div class="setrow"><span>Importer une sauvegarde</span><button class="btn sec small" data-act="import">Importer</button></div>
    </div>
    <input type="file" id="importFile" accept="application/json" hidden>`;
}

function updateBadge() {
  try {
    const n = pendingCount();
    if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  } catch (e) { /* non supporté */ }
}

/* ---------- Boîtes de dialogue ---------- */
const dlg = $('#dlg');
function openDialog(html) { dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
const closeDialog = () => dlg.open && dlg.close();
dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });

const isCourse = id => !!id && subject(id).course !== false;
const subjectOptions = (sel, withNone, onlyCourses) => (withNone ? `<option value=\"\" ${!sel ? 'selected' : ''}>Aucune (pas un cours)</option>` : '') + subjects().filter(s => !onlyCourses || s.course !== false || s.id === sel).map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
const REPEATS = [['none', 'Jamais'], ['daily', 'Chaque jour'], ['weekly', 'Chaque semaine'], ['biweekly', 'Toutes les 2 semaines'], ['monthly', 'Chaque mois'], ['yearly', 'Chaque année']];
const repeatLabel = k => (REPEATS.find(r => r[0] === k) || REPEATS[2])[1].toLowerCase();
const REMINDERS = [[15, '15 min avant'], [30, '30 min avant'], [60, '1 h avant'], [120, '2 h avant'], [1440, 'La veille (24 h)']];

/* ----- Événement ----- */
function eventForm(ev, opts = {}) {
  const e = ev || { title: '', subjectId: 'chinois', date: opts.date || today(), endDate: '', time: '18:00', endTime: '19:00', place: '', repeat: 'none', until: '', reminders: [60] };
  const rems = evReminders(e);
  const heading = opts.dup ? 'Dupliquer l\'événement' : ev ? 'Modifier la série' : 'Nouvel événement';
  openDialog(`
    <h3>${heading}</h3>
    <label>Titre</label><input type="text" id="f-title" value="${esc(e.title)}" placeholder="Cours de chinois">
    <label>Matière / catégorie</label><select id="f-subject">${subjectOptions(e.subjectId, true)}</select>
    <label>Date</label><input type="date" id="f-date" value="${e.date}">
    <label class="inline"><input type="checkbox" id="f-allday" ${e.time ? '' : 'checked'}> Toute la journée / sans heure</label>
    <div id="w-time"><label>Heure</label><input type="time" id="f-time" value="${e.time || '18:00'}"></div>
    <div id="w-etime"><label>Heure de fin (facultatif)</label><input type="time" id="f-etime" value="${e.endTime || ''}"></div>
    <label>Répétition</label>
    <select id="f-repeat">${REPEATS.map(([v, l]) => `<option value="${v}" ${(e.repeat || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div id="w-end"><label>Date de fin (événement sur plusieurs jours, facultatif)</label><input type="date" id="f-end" value="${e.endDate || ''}"></div>
    <div id="w-until"><label>Répéter jusqu'au (facultatif)</label><input type="date" id="f-until" value="${e.until || ''}"></div>
    <label>Lieu</label><input type="text" id="f-place" value="${esc(e.place)}">
    <label class="inline"><input type="checkbox" id="f-countdown" ${e.countdown ? 'checked' : ''}> Compte à rebours (J-…) sur l'accueil</label>
    <div id="w-rem"><label>Rappels avant</label>
      <div class="checks">${REMINDERS.map(([v, l]) => `<label><input type="checkbox" name="f-rem" value="${v}" ${rems.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</div></div>
    <div class="actions">
      <button class="btn" data-act="save-event" data-id="${ev && !opts.dup ? ev.id : ''}">Enregistrer</button>
      <button class="btn sec" data-act="close">Fermer</button>
      ${ev && !opts.dup ? `<button class="btn sec" data-act="dup-event" data-id="${ev.id}">Dupliquer</button>
      <button class="btn danger right" data-act="delete-event" data-id="${ev.id}">Supprimer la série</button>` : ''}
    </div>`);
  const sync = () => {
    const allDay = $('#f-allday').checked, rep = $('#f-repeat').value !== 'none';
    $('#w-time').hidden = allDay; $('#w-etime').hidden = allDay; $('#w-rem').hidden = allDay;
    $('#w-end').hidden = rep; $('#w-until').hidden = !rep;
  };
  if (!ev) $('#f-time').addEventListener('input', () => { $('#f-etime').value = plusHour($('#f-time').value); });
  ['#f-allday', '#f-repeat'].forEach(s => $(s).addEventListener('change', sync));
  sync();
}

function saveEvent(id) {
  const title = $('#f-title').value.trim();
  const date = $('#f-date').value;
  if (!title || !date) { alert('Titre et date obligatoires.'); return; }
  const allDay = $('#f-allday').checked, repeat = $('#f-repeat').value !== 'none';
  const end = $('#f-end').value, until = $('#f-until').value;
  if (!repeat && end && end < date) { alert('La date de fin est avant le début.'); return; }
  if (repeat && until && until < date) { alert('« Jusqu\'au » est avant le début.'); return; }
  const time = allDay ? '' : ($('#f-time').value || '');
  const endTime = time ? ($('#f-etime').value || '') : '';
  if (endTime && endTime <= time) { alert("L\u2019heure de fin doit \u00eatre apr\u00e8s le d\u00e9but."); return; }
  const data = {
    title, date, subjectId: $('#f-subject').value, time, endTime,
    endDate: !repeat && end > date ? end : '', until: repeat ? until : '',
    place: $('#f-place').value.trim(), repeat: $('#f-repeat').value, countdown: $('#f-countdown').checked,
    reminders: allDay || !time ? [] : [...document.querySelectorAll('input[name=f-rem]:checked')].map(x => Number(x.value)),
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
  const cur = o || { date: orig, time: ev.time, days: 1 };
  const span = !isRepeat(ev) && ev.endDate ? ` → ${fmtShort(ev.endDate)}` : '';
  const note = (ev.sessionNotes || {})[orig] || '';
  openDialog(`
    <h3>${esc(ev.title)}</h3>
    <p class="muted">${esc(fmtDay(cur.date))}${span}${cur.time ? ' à ' + esc(timeSpan(cur.time, ev)) : ''}${ev.place ? ' · ' + esc(ev.place) : ''}${ex && ex.cancelled ? ' — <b>annulée</b>' : ''}</p>
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
    <div class="actions"><button class="btn sec" data-act="edit-event" data-id="${id}">Modifier la série</button><button class="btn sec" data-act="dup-event" data-id="${id}">Dupliquer</button><button class="btn sec right" data-act="close">Fermer</button></div>`);
}

/* ----- Devoir ----- */
function hwForm(h, opts = {}) {
  const e = h || { title: '', subjectId: 'chinois', dueNext: true, due: null };
  const mode0 = e.recur ? (e.recur.days.length === 7 ? 'daily' : 'days') : e.dueNext ? 'next' : e.due ? 'date' : 'none';
  const days = e.recur ? e.recur.days : [1, 2, 3, 4, 5];
  const opt = (v, l) => `<option value="${v}" ${mode0 === v ? 'selected' : ''}>${l}</option>`;
  const heading = opts.dup ? 'Dupliquer le devoir' : h ? 'Modifier le devoir' : 'Nouveau devoir';
  openDialog(`
    <h3>${heading}</h3>
    <label>Devoir</label><input type="text" id="h-title" value="${esc(e.title)}" placeholder="Exercices page 42">
    <label>Matière</label><select id="h-subject">${subjectOptions(e.subjectId, false, true)}</select>
    <label>À rendre</label>
    <select id="h-mode">${opt('next', 'Pour la prochaine séance')}${opt('date', 'À une date précise')}${opt('none', 'Sans date limite')}${opt('daily', 'Chaque jour')}${opt('days', 'Certains jours de la semaine')}</select>
    <div id="h-datewrap" hidden><label>Date limite</label><input type="date" id="h-date" value="${e.due || addDays(today(), 1)}"></div>
    <div id="h-dayswrap" hidden><label>Jours</label><div class="checks">${WD_ORDER.map(d => `<label><input type="checkbox" name="h-day" value="${d}" ${days.includes(d) ? 'checked' : ''}> ${WD[d]}</label>`).join('')}</div></div>
    <div class="actions">
      <button class="btn" data-act="save-hw" data-id="${h && !opts.dup ? h.id : ''}">${h && !opts.dup ? 'Enregistrer' : 'Ajouter'}</button>
      <button class="btn sec" data-act="close">Fermer</button>
      ${h && !opts.dup ? `<button class="btn sec" data-act="dup-hw" data-id="${h.id}">Dupliquer</button><button class="btn danger right" data-act="delete-hw" data-id="${h.id}">Supprimer</button>` : ''}
    </div>`);
  const sync = () => {
    const m = $('#h-mode').value;
    $('#h-datewrap').hidden = m !== 'date'; $('#h-dayswrap').hidden = m !== 'days';
  };
  $('#h-mode').addEventListener('change', sync); sync();
}

function saveHw(id) {
  const title = $('#h-title').value.trim();
  if (!title) { alert('Écris le devoir.'); return; }
  const m = $('#h-mode').value;
  const data = { title, subjectId: $('#h-subject').value, due: m === 'date' ? $('#h-date').value : null, dueNext: m === 'next', recur: undefined };
  if (m === 'daily') data.recur = { days: [0, 1, 2, 3, 4, 5, 6] };
  if (m === 'days') {
    const days = [...document.querySelectorAll('input[name=h-day]:checked')].map(x => Number(x.value));
    if (!days.length) { alert('Choisis au moins un jour.'); return; }
    data.recur = { days };
  }
  if (id) {
    const h = db.homework.find(x => x.id === id);
    Object.assign(h, data); touch(h);
  } else {
    db.homework.push(touch({ id: uid(), created: today(), done: false, doneAt: null, doneOn: {}, ...data }));
  }
  save(); closeDialog(); render();
}

/* ----- Pratique du violon ----- */
function practiceDialog(d = today()) {
  openDialog(`
    <h3>${d === today() ? 'Pratique du violon' : 'Pratique du violon : ' + esc(fmtShort(d))}</h3>
    <label>Minutes (facultatif)</label><input type="text" inputmode="numeric" id="p-min" placeholder="30">
    <div class="actions"><button class="btn" data-act="save-practice" data-date="${d}">Valider</button><button class="btn sec" data-act="close">Fermer</button></div>`);
}

function statsDialog() {
  const t = today();
  const goal = db.settings.practiceGoal;
  const start = addDays(weekStart(t), -77); // 12 semaines, colonnes = semaines, lignes = lundi..dimanche
  let heat = '';
  for (let i = 0; i < 84; i++) {
    const d = addDays(start, i);
    const m = minutesOn(db, d);
    const lvl = !practiced(db, d) ? 0 : !m ? 2 : m < 15 ? 1 : m < 30 ? 2 : 3;
    heat += `<button class="l${lvl} ${d > t ? 'fut' : ''}" data-pday="${d}" title="${esc(fmtShort(d))}${m ? ' · ' + m + ' min' : ''}" ${d > t ? 'disabled' : ''}></button>`;
  }
  let weeks = '';
  for (let w = 0; w < 4; w++) {
    const ws = addDays(weekStart(t), -7 * w);
    let days = 0, mins = 0;
    for (let i = 0; i < 7; i++) { const d = addDays(ws, i); if (practiced(db, d)) { days++; mins += minutesOn(db, d); } }
    weeks += `<div class="stat"><span>${w === 0 ? 'Cette semaine' : 'Semaine du ' + esc(fmtShort(ws))}</span><b>${days} j · ${mins} min</b></div>`;
  }
  openDialog(`
    <h3>Statistiques violon</h3>
    <div class="stat"><span>Série en cours</span><b>${currentStreak(db, t)} j</b></div>
    <div class="stat"><span>Meilleure série</span><b>${bestStreak(db)} j</b></div>
    ${goal > 0 ? `<div class="stat"><span>Objectif de la semaine</span><b>${weekPracticeDays(db, t)}/${goal} j</b></div>` : ''}
    <h2>4 dernières semaines</h2>${weeks}
    <h2>12 semaines</h2><div class="heat">${heat}</div>
    <small>Touche un jour pour le cocher ou le décocher (oubli d'un jour passé).</small>
    <div class="actions"><button class="btn sec" data-act="close">Fermer</button></div>`);
}

/* ----- Recherche ----- */
function searchDialog() {
  openDialog(`
    <h3>Rechercher</h3>
    <input type="text" id="q" placeholder="Événement, devoir, note…" autocomplete="off">
    <div id="qres" class="results"></div>
    <div class="actions"><button class="btn sec" data-act="close">Fermer</button></div>`);
  const input = $('#q');
  input.addEventListener('input', () => { $('#qres').innerHTML = searchResults(norm(input.value.trim())); });
  input.focus();
}

function searchResults(q) {
  if (q.length < 2) return '<div class="note" style="padding:12px 0">Écris au moins 2 lettres.</div>';
  const evs = live(db.events).filter(ev => norm(ev.title + ' ' + ev.place + ' ' + subject(ev.subjectId).name).includes(q));
  const notes = allNotes().filter(n => norm(n.text + ' ' + n.ev.title).includes(q));
  const hws = live(db.homework).filter(h => norm(h.title + ' ' + subject(h.subjectId).name).includes(q));
  const evRow = ev => {
    const s = subject(ev.subjectId);
    return `<div class="row" data-occ="${ev.id}@${ev.date}"><span class="dot" style="background:${s.color}"></span>
      <div class="grow"><b>${esc(ev.title)}</b><small>${isRepeat(ev) ? repeatLabel(ev.repeat) + ' · depuis le ' : ''}${esc(fmtShort(ev.date))}${ev.time ? ' · ' + esc(ev.time) : ''}</small></div></div>`;
  };
  const html = [
    evs.length ? `<h2>Événements</h2>${evs.map(evRow).join('')}` : '',
    notes.length ? `<h2>Notes de séance</h2>${notes.map(noteRow).join('')}` : '',
    hws.length ? `<h2>Devoirs</h2>${hws.map(h => hwRow(h)).join('')}` : '',
  ].join('');
  return html || '<div class="note" style="padding:12px 0">Aucun résultat.</div>';
}

/* ----- Sauvegardes du serveur ----- */
async function backupsDialog() {
  openDialog('<h3>Sauvegardes du serveur</h3><p class="muted">Chargement…</p>');
  try {
    const { dates } = await api('/api/backups');
    const label = d => d === 'avant-restauration' ? 'Avant la dernière restauration' : fmtDay(d);
    openDialog(`
      <h3>Sauvegardes du serveur</h3>
      <div class="actions" style="margin-top:0"><button class="btn small" data-act="backup-now">Sauvegarder maintenant</button></div>
      <div class="card" style="margin-top:12px">${dates.length
        ? dates.map(d => `<div class="setrow"><span>${esc(label(d))}</span><button class="btn sec small" data-act="restore-backup" data-date="${d}">Restaurer</button></div>`).join('')
        : '<div class="empty">Aucune sauvegarde pour l\'instant (la première est faite cette nuit).</div>'}</div>
      <small>Restaurer remplace tes données actuelles (une copie de l'état actuel est gardée).</small>
      <div class="actions"><button class="btn sec" data-act="close">Fermer</button></div>`);
  } catch (e) {
    openDialog('<h3>Sauvegardes du serveur</h3><p class="muted">Serveur injoignable.</p><div class="actions"><button class="btn sec" data-act="close">Fermer</button></div>');
  }
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
  'dup-event': b => eventForm(db.events.find(x => x.id === b.dataset.id), { dup: true }),
  'delete-event': b => { closeDialog(); softDelete([db.events.find(x => x.id === b.dataset.id)], 'Événement supprimé'); },
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
    touch(ev); save(); closeDialog(); render();
  },
  'save-hw': b => saveHw(b.dataset.id),
  'dup-hw': b => hwForm(db.homework.find(x => x.id === b.dataset.id), { dup: true }),
  'delete-hw': b => { closeDialog(); softDelete([db.homework.find(x => x.id === b.dataset.id)], 'Devoir supprimé'); },
  'clear-done': () => {
    const list = live(db.homework).filter(h => !h.recur && h.done);
    if (list.length) softDelete(list, `${list.length} devoir${list.length > 1 ? 's' : ''} supprimé${list.length > 1 ? 's' : ''}`);
  },
  'add-subject': () => {
    const name = ($('#newSubject').value || '').trim();
    if (!name) return;
    const palette = ['#e0483e', '#7b4fd6', '#2f8f6f', '#e0912e', '#2f7fd6', '#c2409a', '#5a6b7b'];
    db.subjects.push(touch({ id: uid(), name, color: palette[subjects().length % palette.length], course: $('#newCourse').checked }));
    save(); render();
  },
  'del-subject': b => {
    const list = subjects();
    if (list.length <= 1) { alert('Il faut garder au moins une matière.'); return; }
    const s = list.find(x => x.id === b.dataset.id);
    const target = list.find(x => x.id !== s.id);
    const used = [...live(db.events), ...live(db.homework)].filter(x => x.subjectId === s.id);
    if (!confirm(`Supprimer « ${s.name} » ?${used.length ? ` Ses ${used.length} événement(s)/devoir(s) passeront dans « ${target.name} ».` : ''}`)) return;
    used.forEach(x => { x.subjectId = target.id; touch(x); });
    touch(Object.assign(s, { deleted: true }));
    save(); render();
  },
  practice: () => practiceDialog(),
  'practice-yday': () => {
    const y = addDays(today(), -1);
    if (practiced(db, y)) { db.practice[y] = touch({ deleted: true }); save(); render(); } else practiceDialog(y);
  },
  stats: statsDialog,
  'save-practice': b => {
    const m = parseInt($('#p-min').value, 10);
    db.practice[b.dataset.date || today()] = touch({ minutes: Number.isFinite(m) && m > 0 ? m : null });
    save(); closeDialog(); render();
  },
  unpractice: () => { db.practice[today()] = touch({ deleted: true }); save(); render(); },
  'add-on-day': () => eventForm(null, { date: selDay }),
  'month-today': () => { month = today().slice(0, 7); selDay = today(); render(); },
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
  backups: backupsDialog,
  'backup-now': async () => {
    try { await api('/api/backup'); await backupsDialog(); } catch (e) { alert('Sauvegarde impossible (serveur injoignable).'); }
  },
  'restore-backup': async b => {
    const date = b.dataset.date;
    if (!confirm('Remplacer toutes tes données actuelles par cette sauvegarde ?')) return;
    try {
      await sync(); // pousse d'abord les modifications en attente pour qu'elles soient dans la copie « avant restauration »
      const { rev, data } = await api('/api/restore', { date });
      db = data; db.settings = { ...DEFAULT_SETTINGS, ...db.settings }; saveLocal();
      serverRev = rev; dirty = false;
      closeDialog(); render();
      alert('Sauvegarde restaurée.');
    } catch (e) { alert('Restauration impossible.'); }
  },
  export: () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' }));
    a.download = `agenda-sauvegarde-${today()}.json`;
    a.click();
  },
  import: () => $('#importFile').click(),
};

let toastTimer = null, toastUndo = null;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="toastUndo">Annuler</button>' : ''}`;
  t.hidden = false;
  toastUndo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastUndo = null; }, 7000);
}

// Suppression (propagée aux autres appareils) avec possibilité d'annuler quelques secondes.
function softDelete(records, msg) {
  records.forEach(r => touch(Object.assign(r, { deleted: true })));
  save(); render();
  toast(msg, () => { records.forEach(r => { delete r.deleted; touch(r); }); save(); render(); });
}

function togglePracticeDay(d) {
  if (d > today()) return;
  db.practice[d] = touch(practiced(db, d) ? { deleted: true } : { minutes: null });
  save(); statsDialog(); render();
}

document.addEventListener('click', e => {
  if (e.target.closest('#toastUndo')) { const f = toastUndo; $('#toast').hidden = true; toastUndo = null; if (f) f(); return; }
  const act = e.target.closest('[data-act]');
  if (act && actions[act.dataset.act]) { actions[act.dataset.act](act); return; }
  if (e.target.closest('[data-check],[data-checkrec]')) return; // géré par 'change'
  const pday = e.target.closest('[data-pday]');
  if (pday) { togglePracticeDay(pday.dataset.pday); return; }
  const o = e.target.closest('[data-occ]');
  if (o) { occDialog(o.dataset.occ); return; }
  const hw = e.target.closest('[data-hw]');
  if (hw) { hwForm(db.homework.find(x => x.id === hw.dataset.hw)); return; }
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); if (tab === 'settings') fetchStatus(); return; }
  const md = e.target.closest('[data-mode]');
  if (md) { mode = md.dataset.mode; render(); return; }
  const dayCell = e.target.closest('[data-day]');
  if (dayCell) { selDay = dayCell.dataset.day; month = selDay.slice(0, 7); render(); return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(nav.dataset.nav), 1);
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    selDay = `${month}-01`; render(); return;
  }
  const nf = e.target.closest('[data-notefilter]');
  if (nf) { noteFilter = nf.dataset.notefilter; render(); return; }
  if (e.target.closest('#searchBtn')) { searchDialog(); return; }
  if (e.target.closest('#fab')) {
    if (tab === 'homework') hwForm(); else eventForm(null, { date: tab === 'agenda' && mode === 'month' ? selDay : undefined });
  }
});

document.addEventListener('change', e => {
  const chk = e.target.closest('[data-check]');
  if (chk) {
    const h = db.homework.find(x => x.id === chk.dataset.check);
    h.done = chk.checked; h.doneAt = chk.checked ? new Date().toISOString() : null;
    touch(h); save(); render(); return;
  }
  const rec = e.target.closest('[data-checkrec]');
  if (rec) {
    const h = db.homework.find(x => x.id === rec.dataset.checkrec);
    h.doneOn = h.doneOn || {};
    if (rec.checked) h.doneOn[today()] = Date.now(); else delete h.doneOn[today()];
    touch(h); save(); render(); return;
  }
  const sn = e.target.closest('[data-subname]');
  if (sn) {
    const sb = db.subjects.find(x => x.id === sn.dataset.subname);
    const v = sn.value.trim();
    if (v && v !== sb.name) { sb.name = v; touch(sb); save(); }
    render(); return;
  }
  const scr = e.target.closest('[data-subcourse]');
  if (scr) { const sb = db.subjects.find(x => x.id === scr.dataset.subcourse); sb.course = scr.checked; touch(sb); save(); render(); return; }
  const sc = e.target.closest('[data-subcolor]');
  if (sc) { const sb = db.subjects.find(x => x.id === sc.dataset.subcolor); sb.color = sc.value; touch(sb); save(); render(); return; }
  const set = e.target.closest('[data-set]');
  if (set) {
    const k = set.dataset.set;
    db.settings[k] = set.type === 'checkbox' ? set.checked : k === 'practiceGoal' ? Number(set.value) : set.value;
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
        [...data.events, ...data.homework, ...Object.values(data.practice || {})].forEach(x => { x.updatedAt = now; });
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
