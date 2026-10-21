// Page logic that works with or without the 3D world: the cards, the schedule, the vote, the text version.
// The world (world.js) is loaded last and only when WebGL works.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const PLACES = ['about', 'meetings', 'argue', 'build', 'join'];

// Club facts. Update these each term. Times are Pacific.
export const SCHEDULE = {
  start: '14:00',
  end: '15:00',
  room: 'CIS A-204',
  // Weeks with a known topic. Later Wednesdays up to `last` count as meetings with no topic yet.
  meetings: [
    { date: '2026-09-30', n: 2, title: 'What is AI, really?' },
    { date: '2026-10-07', n: 3, title: 'How AI reads your words' },
    { date: '2026-10-14', n: 4, title: 'Let’s argue about AI' },
    { date: '2026-10-21', n: 5, title: 'Build One Thing' },
    { date: '2026-10-28', n: 6, title: 'Under the Hood' },
  ],
  off: ['2026-11-11', '2026-11-25'],
  last: '2026-12-02',
};

/* ---------- Pacific time ---------- */

const TZ = 'America/Los_Angeles';

// Minutes Pacific time is behind UTC at a given instant (420 in summer, 480 in winter).
function offsetMinutes(at) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(at);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Math.round((Math.floor(at.getTime() / 60000) * 60000 - wall) / 60000);
  } catch {
    return 480;
  }
}

// The instant a Pacific wall-clock time happens, e.g. pacific('2026-10-28', '14:00').
function pacific(date, hm) {
  const naive = new Date(`${date}T${hm}:00Z`);
  return new Date(naive.getTime() + offsetMinutes(naive) * 60000);
}

function pacificDay(at) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

export function nextMeeting(now = new Date()) {
  const known = SCHEDULE.meetings;
  const dates = known.map((m) => m.date);
  if (!dates.length) return null;
  for (let d = addDays(dates[dates.length - 1], 7); d <= SCHEDULE.last; d = addDays(d, 7)) {
    if (!SCHEDULE.off.includes(d)) dates.push(d);
  }
  for (const date of dates) {
    const start = pacific(date, SCHEDULE.start);
    const end = pacific(date, SCHEDULE.end);
    if (end <= now) continue;
    const meta = known.find((m) => m.date === date) || {};
    return { date, start, end, live: start <= now, title: meta.title || '', n: meta.n, days: daysBetween(pacificDay(now), date) };
  }
  return null;
}

/* ---------- Cards ---------- */

const panel = $('#panel');
const cards = Object.fromEntries($$('.station', panel).map((el) => [el.dataset.station, el]));
const navLinks = $$('.places a');
const listeners = { go: [], vote: [], open: [], close: [] };
let current = null;
let openedHow = null;
let dismissed = null;

for (const card of Object.values(cards)) {
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'close';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '×';
  x.addEventListener('click', () => ui.close('button'));
  card.prepend(x);
}

export const ui = {
  get current() { return current; },
  get dismissed() { return dismissed; },
  get text() { return document.body.classList.contains('text'); },
  on(evt, fn) { listeners[evt].push(fn); },
  emit(evt, ...args) { for (const fn of listeners[evt]) fn(...args); },

  open(id, how = 'nav') {
    if (!cards[id]) return;
    if (how === 'zone' && dismissed === id) return;
    dismissed = null;
    openedHow = how;
    if (current !== id) {
      if (current) cards[current].classList.remove('on');
      current = id;
      const card = cards[id];
      card.classList.remove('on');
      void card.offsetWidth; // replay the entrance
      card.classList.add('on');
      card.scrollTop = 0;
    }
    for (const a of navLinks) a.setAttribute('aria-current', String(a.dataset.go === id));
    if (how !== 'welcome') history.replaceState(null, '', `#${id}`);
    ui.emit('open', id, how);
  },

  close(how = 'button') {
    if (!current) return;
    // A closed card stays shut until you leave that place. The welcome card opens before you are anywhere.
    if (how === 'button' && openedHow !== 'welcome') dismissed = current;
    cards[current].classList.remove('on');
    current = null;
    for (const a of navLinks) a.setAttribute('aria-current', 'false');
    ui.emit('close', how);
  },

  // Called when the visitor leaves a place, so walking back in opens it again.
  forget(id) { if (dismissed === id) dismissed = null; },

  focusMeeting(n) {
    const note = $(`[data-meeting="${n}"]`, cards.meetings);
    if (!note) return;
    note.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    note.classList.remove('flash');
    void note.offsetWidth;
    note.classList.add('flash');
  },

  vote: null,
  setVote(n, from = 'ui') {
    if (n === ui.vote && from !== 'ui') return;
    ui.vote = n;
    for (const b of $$('[data-vote]', cards.argue)) b.setAttribute('aria-pressed', String(Number(b.dataset.vote) === n));
    $('[data-vote-status]', cards.argue).textContent = n == null ? 'Stand on a number.' : `You’re on ${n}.`;
    const bubbles = $('.bubbles', cards.argue);
    if (n != null && bubbles.hidden) {
      bubbles.hidden = false;
      bubbles.classList.remove('go');
      void bubbles.offsetWidth;
      bubbles.classList.add('go');
    }
    try { localStorage.setItem('explorai-vote', String(n)); } catch { /* storage blocked */ }
    ui.emit('vote', n, from);
  },

  hideHint() { $('#hint')?.classList.add('gone'); },
};

if (matchMedia('(pointer: coarse)').matches) $('#hint').textContent = 'Tap the ground to walk. Drag to look around.';

/* ---------- Schedule on the page ---------- */

function fillSchedule() {
  const fmt = (hm) => {
    const [h, m] = hm.split(':').map(Number);
    return { t: `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`, ap: h < 12 ? 'am' : 'pm' };
  };
  const a = fmt(SCHEDULE.start), b = fmt(SCHEDULE.end);
  const span = a.ap === b.ap ? `${a.t} to ${b.t} ${b.ap}` : `${a.t} ${a.ap} to ${b.t} ${b.ap}`;
  $('[data-fill="time"]').textContent = `${span} · ${SCHEDULE.room}`;
  $('[data-fill="join"]').textContent = `Wednesdays, ${span}, ${SCHEDULE.room}. Bring a laptop if you have one.`;

  const next = nextMeeting();
  const box = $('[data-next]');
  for (const li of $$('[data-meeting]', cards.meetings)) {
    li.classList.toggle('is-next', !!next && li.dataset.date === next.date);
    $('.badge', li)?.remove();
    if (next && li.dataset.date === next.date) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = next.live ? 'Now' : 'Next';
      $('.tag', li).append(badge);
    }
  }
  if (!next) { box.hidden = true; return next; }
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(next.start);
  $('[data-next-what]', box).textContent = next.title ? `${day} · ${next.title}` : day;
  $('[data-next-in]', box).textContent = next.live ? 'Happening now' : next.days === 0 ? 'Today' : next.days === 1 ? 'Tomorrow' : `In ${next.days} days`;
  box.classList.toggle('live', next.live);
  $('.k', box).textContent = next.live ? 'Right now' : 'Next meeting';
  box.hidden = false;
  return next;
}

// A bad schedule edit should cost the "next meeting" line, never the whole page
function refreshSchedule() {
  try { return fillSchedule(); } catch (err) { console.error(err); $('[data-next]').hidden = true; return null; }
}
export let upcoming = refreshSchedule();
setInterval(() => { upcoming = refreshSchedule(); }, 60000);

/* ---------- Clicks and keys ---------- */

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    const id = go.dataset.go;
    if (ui.text) {
      e.preventDefault();
      cards[id].scrollIntoView({ behavior: 'smooth' });
      history.replaceState(null, '', `#${id}`);
      return;
    }
    e.preventDefault();
    ui.open(id, 'nav');
    ui.emit('go', id);
    return;
  }
  const v = e.target.closest('[data-vote]');
  if (v) ui.setVote(Number(v.dataset.vote), 'ui');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ui.text && current) ui.close('button');
});

const modeBtn = $('#mode');
function setText(on) {
  document.body.classList.toggle('text', on);
  modeBtn.textContent = on ? '3D version' : 'Text version';
  if (on) {
    for (const card of Object.values(cards)) card.classList.remove('on');
    const id = current || location.hash.slice(1);
    if (cards[id]) requestAnimationFrame(() => cards[id].scrollIntoView());
  } else if (current) {
    cards[current].classList.add('on');
  }
}
modeBtn.addEventListener('click', () => {
  setText(!ui.text);
  if (!ui.text) startWorld();
});

/* ---------- Start ---------- */

try {
  const saved = localStorage.getItem('explorai-vote');
  if (/^[0-5]$/.test(saved || '')) ui.setVote(Number(saved), 'restore');
} catch { /* storage blocked */ }

function webgl() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

const loading = $('#loading');
const hashPlace = () => (PLACES.includes(location.hash.slice(1)) ? location.hash.slice(1) : null);
let worldStarted = false;

function textOnly() {
  document.body.classList.add('no3d');
  setText(true);
  loading.classList.add('gone');
}

// The 3D world loads on first use, so the text version (?text) stays light until someone switches.
function startWorld() {
  if (worldStarted) return;
  worldStarted = true;
  loading.classList.remove('gone');
  import('./world.js')
    .then((m) => m.start(ui, { startAt: current || hashPlace() }))
    .then(() => loading.classList.add('gone'))
    .catch((err) => { console.error(err); textOnly(); });
}

if (!webgl()) textOnly();
else if (new URLSearchParams(location.search).has('text')) { setText(true); loading.classList.add('gone'); }
else startWorld();
