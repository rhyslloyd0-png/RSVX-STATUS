// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-purple; icon-glyph: server;

// RSVX Status widget for Scriptable (iPhone and iPad).
//
// Shows the RSVX Status board on the Home Screen or Lock Screen: whether
// everything is running, CPU / RAM / disk of the server, the watched services,
// and what failed when a check goes down.
//
// Setup: run this script once inside Scriptable. It asks for the board address
// and password and keeps them in the iOS Keychain. Then add a Scriptable widget
// and pick this script. Run it in the app again to change the settings.
//
// Contact: rhys@rsvx.co.uk

// If Scriptable's setup prompt does not work on your iOS version, fill these two
// in instead and leave the prompt alone. They win over anything typed there.
const BOARD_URL = '';      // for example 'http://203.0.113.10:8787'
const BOARD_PASSWORD = '';

const KEY_URL = 'rsvx_status_url';
const KEY_PASSWORD = 'rsvx_status_password';
const KEY_COOKIE = 'rsvx_status_cookie';
const CACHE_FILE = 'rsvx-status-last.json';
const REFRESH_MINUTES = 5; // a request to iOS, which decides the real timing

const C = {
  bg: new Color('#0c0c0f'), track: new Color('#26262e'), text: new Color('#ededf0'), muted: new Color('#8d8d9a'),
  purple: new Color('#8457e6'), ok: new Color('#3fb950'), warn: new Color('#d9a520'), down: new Color('#e5484d'),
  pending: new Color('#4c8dff'), idle: new Color('#5c5c68'),
};
const stateColour = (s) => C[s] || C.idle;
const mono = (size) => new Font('Menlo', size);

// ---- settings ------------------------------------------------------------

function saved(key) {
  return Keychain.contains(key) ? Keychain.get(key) || '' : '';
}
const boardUrl = () => (BOARD_URL || saved(KEY_URL)).trim().replace(/\/+$/, '');
const boardPassword = () => BOARD_PASSWORD || saved(KEY_PASSWORD);

async function say(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('OK');
  await a.presentAlert();
}

async function askSettings() {
  const a = new Alert();
  a.title = 'RSVX Status';
  a.message = 'The address of your status board, including the port, and the password you open it with.';
  const urlField = a.addTextField('http://your-server:8787', saved(KEY_URL));
  const passwordField = a.addSecureTextField('Password', saved(KEY_PASSWORD));
  a.addAction('Save');
  a.addCancelAction('Cancel');
  if ((await a.presentAlert()) === -1) return false;
  // Depending on the Scriptable and iOS version the typed text comes back from
  // textFieldValue() or from the field itself, and can be null.
  const typed = (field, index) => {
    let v = null;
    try { v = a.textFieldValue(index); } catch (e) { /* older or newer API */ }
    if (v == null && field && typeof field.text === 'string') v = field.text;
    return v == null ? '' : String(v);
  };
  const url = typed(urlField, 0).trim().replace(/\/+$/, '');
  if (!url) {
    await say('Address not saved', 'Scriptable did not hand back what was typed. Open the script in the editor and put the address and password in the BOARD_URL and BOARD_PASSWORD lines near the top, then run it again.');
    return false;
  }
  Keychain.set(KEY_URL, url);
  Keychain.set(KEY_PASSWORD, typed(passwordField, 1));
  if (Keychain.contains(KEY_COOKIE)) Keychain.remove(KEY_COOKIE);
  return true;
}

// ---- talking to the board ------------------------------------------------

async function getStatus(base, cookie) {
  const r = new Request(base + '/api/status');
  r.timeoutInterval = 12;
  if (cookie) r.headers = { Cookie: cookie };
  try {
    const text = await r.loadString();
    return { reached: true, status: r.response.statusCode, text };
  } catch (e) {
    return { reached: false, why: String(e && e.message ? e.message : e) };
  }
}

// The board answers a correct password with a redirect that carries the cookie.
async function login(base, password) {
  const r = new Request(base + '/login');
  r.method = 'POST';
  r.timeoutInterval = 12;
  r.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  r.body = 'password=' + encodeURIComponent(password);
  r.onRedirect = () => null; // stay on the answer that has the cookie
  try {
    await r.loadString();
  } catch (e) {
    return { reached: false };
  }
  const res = r.response || {};
  let cookie = '';
  const fromList = (res.cookies || []).find((c) => c.name === 'rsvx_status');
  if (fromList) cookie = 'rsvx_status=' + fromList.value;
  if (!cookie) {
    const headers = res.headers || {};
    const raw = String(headers['Set-Cookie'] || headers['set-cookie'] || '');
    const m = /rsvx_status=[^;,\s]+/.exec(raw);
    if (m) cookie = m[0];
  }
  return { reached: true, status: res.statusCode, cookie };
}

// Returns { board } on success or { error } with a short reason.
async function fetchBoard() {
  const base = boardUrl();
  if (!/^https?:\/\/[^/]+/i.test(base) || base.includes('your-server')) return { error: 'Run the script in Scriptable to set the board address' };

  let r = await getStatus(base, saved(KEY_COOKIE));
  if (r.reached && r.status === 401) {
    const password = boardPassword();
    if (!password) return { error: 'The board needs a password' };
    const l = await login(base, password);
    if (!l.reached) return { error: 'The board is not answering' };
    if (!l.cookie) return { error: l.status === 429 ? 'Too many logins, try again later' : 'Wrong board password' };
    Keychain.set(KEY_COOKIE, l.cookie);
    r = await getStatus(base, l.cookie);
  }
  if (!r.reached) return { error: 'The board is not answering' };
  if (r.status !== 200) return { error: 'The board answered HTTP ' + r.status };
  try {
    return { board: readBoard(JSON.parse(r.text)) };
  } catch (e) {
    return { error: "Could not read the board's answer" };
  }
}

const GROUP = { vps: 'VPS', render: 'Render', github: 'GitHub', sites: 'Web' };

function readBoard(d) {
  if (!d || !Array.isArray(d.checks)) throw new Error('no checks');
  const live = d.checks.filter((c) => c.status !== 'idle');
  const failures = live.filter((c) => c.status === 'down' || c.status === 'warn')
    .sort((a, b) => (a.status === 'down' ? 0 : 1) - (b.status === 'down' ? 0 : 1))
    .map((c) => ({ name: String(c.name || ''), summary: String(c.summary || ''), group: GROUP[c.group] || '', state: c.status }));
  const host = d.checks.find((c) => c.group === 'vps' && c.kind === 'host');
  const bars = ((host && host.bars) || []).map((b) => ({
    label: String(b.label || ''), value: Math.max(0, Math.min(100, Number(b.value) || 0)),
  }));
  const services = d.checks.filter((c) => c.group === 'vps' && c.kind === 'service')
    .map((c) => ({ name: String(c.name || ''), state: c.status }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const overall = !d.ready ? 'pending' : failures.some((f) => f.state === 'down') ? 'down' : failures.length ? 'warn' : 'ok';
  return { ready: !!d.ready, live: live.length, bad: failures.length, overall, failures, bars, services, host: String(d.host || ''), at: Date.now() };
}

// ---- last good answer, so a dead board still shows something --------------

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
}
function readCache() {
  try {
    const fm = FileManager.local();
    return fm.fileExists(cachePath()) ? JSON.parse(fm.readString(cachePath())) : null;
  } catch (e) {
    return null;
  }
}
function writeCache(board) {
  try { FileManager.local().writeString(cachePath(), JSON.stringify(board)); } catch (e) { /* cache is best effort */ }
}

// ---- drawing -------------------------------------------------------------

function headline(view) {
  if (view.error) return 'No data';
  const b = view.board;
  if (!b.ready) return 'Checking';
  if (b.bad) return b.bad + (b.bad === 1 ? ' needs attention' : ' need attention');
  return 'All running';
}

function clock(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function square(stack, size, colour) {
  const s = stack.addStack();
  s.size = new Size(size, size);
  s.backgroundColor = colour;
  s.cornerRadius = 0;
  return s;
}

function label(stack, text, font, colour, lines) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = colour;
  t.lineLimit = lines || 1;
  t.minimumScaleFactor = 0.8;
  return t;
}

function header(parent, view) {
  const row = parent.addStack();
  row.centerAlignContent();
  square(row, 8, stateColour(view.state));
  row.addSpacer(6);
  label(row, 'RSVX', Font.boldSystemFont(11), C.text);
  row.addSpacer(3);
  label(row, 'STATUS', Font.boldSystemFont(11), C.purple);
  row.addSpacer();
  const b = view.board;
  const when = b ? clock(b.at) : '';
  label(row, view.error && when ? 'last ' + when : when, mono(9), C.muted);
}

function bar(parent, b, width, dim) {
  const top = parent.addStack();
  top.size = new Size(width, 12);
  top.centerAlignContent();
  label(top, b.label.replace(/^Disk\s+/, 'Disk '), mono(9), C.muted);
  top.addSpacer();
  const fill = b.value >= 95 ? C.down : b.value >= 85 ? C.warn : C.purple;
  label(top, Math.round(b.value) + '%', mono(9), fill === C.purple ? C.text : fill);
  parent.addSpacer(2);
  const track = parent.addStack();
  track.size = new Size(width, 4);
  track.backgroundColor = C.track;
  track.cornerRadius = 0;
  const filled = Math.round(width * b.value / 100);
  if (filled > 0) {
    const f = track.addStack();
    f.size = new Size(filled, 4);
    f.backgroundColor = fill;
    f.cornerRadius = 0;
  }
  track.addSpacer();
  if (dim) { top.opacity = 0.45; track.opacity = 0.45; }
}

function failureRow(parent, f, withSummary) {
  const row = parent.addStack();
  row.centerAlignContent();
  square(row, 7, stateColour(f.state));
  row.addSpacer(6);
  label(row, f.name, Font.semiboldSystemFont(12), C.text);
  if (withSummary && f.group) {
    row.addSpacer();
    label(row, f.group.toUpperCase(), mono(8), stateColour(f.state));
  }
  if (withSummary && f.summary) {
    const sub = parent.addStack();
    sub.addSpacer(13);
    label(sub, f.summary, Font.systemFont(10), C.muted);
  }
}

function failureList(parent, failures, max, withSummary) {
  const shown = failures.slice(0, failures.length > max ? max - 1 : max);
  shown.forEach((f, i) => {
    if (i) parent.addSpacer(withSummary ? 5 : 3);
    failureRow(parent, f, withSummary);
  });
  if (failures.length > shown.length) {
    parent.addSpacer(3);
    label(parent, 'and ' + (failures.length - shown.length) + ' more', Font.systemFont(10), C.muted);
  }
}

function serviceList(parent, services, max, dim) {
  services.slice(0, max).forEach((s, i) => {
    if (i) parent.addSpacer(3);
    const row = parent.addStack();
    row.centerAlignContent();
    square(row, 6, stateColour(s.state));
    row.addSpacer(6);
    label(row, s.name, mono(10), s.state === 'down' ? C.down : C.text);
    if (dim) row.opacity = 0.45;
  });
}

function baseWidget(view) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.setPadding(13, 14, 13, 14);
  const base = boardUrl();
  if (/^https?:\/\//i.test(base)) w.url = base;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  header(w, view);
  w.addSpacer(8);
  return w;
}

function smallWidget(view) {
  const w = baseWidget(view);
  const b = view.board;
  label(w, headline(view), Font.boldSystemFont(15), view.state === 'ok' ? C.text : stateColour(view.state));
  if (view.error) {
    w.addSpacer(3);
    label(w, view.error, Font.systemFont(10), C.muted, 3);
    w.addSpacer();
    return w;
  }
  w.addSpacer(2);
  label(w, (b.live - b.bad) + ' of ' + b.live + ' checks passing', Font.systemFont(10), C.muted);
  w.addSpacer();
  if (b.bad) {
    failureList(w, b.failures, 4, false);
  } else {
    b.bars.slice(0, 3).forEach((x, i) => {
      if (i) w.addSpacer(5);
      bar(w, x, 127, false);
    });
  }
  return w;
}

function mediumWidget(view) {
  const w = baseWidget(view);
  const b = view.board;
  const cols = w.addStack();
  cols.topAlignContent();

  const left = cols.addStack();
  left.layoutVertically();
  label(left, headline(view), Font.boldSystemFont(15), view.state === 'ok' ? C.text : stateColour(view.state));
  left.addSpacer(2);
  if (view.error) label(left, view.error, Font.systemFont(10), C.muted, 2);
  else label(left, (b.live - b.bad) + ' of ' + b.live + ' checks passing', Font.systemFont(10), C.muted);
  if (b) {
    left.addSpacer(9);
    b.bars.slice(0, 3).forEach((x, i) => {
      if (i) left.addSpacer(5);
      bar(left, x, 138, !!view.error);
    });
  }

  cols.addSpacer(16);
  const right = cols.addStack();
  right.layoutVertically();
  if (b && b.bad && !view.error) failureList(right, b.failures, 3, true);
  else if (b) serviceList(right, b.services, 7, !!view.error);
  cols.addSpacer();
  w.addSpacer();
  return w;
}

// Lock Screen widgets are drawn by iOS in one colour, so they are text only.
function lockWidget(view, family) {
  const w = new ListWidget();
  const base = boardUrl();
  if (/^https?:\/\//i.test(base)) w.url = base;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  const b = view.board;
  const bad = !view.error && b && b.bad;

  if (family === 'accessoryInline') {
    w.addText('RSVX: ' + (view.error ? 'no data' : bad ? b.failures[0].name + (b.bad > 1 ? ' +' + (b.bad - 1) : '') + ' down' : headline(view).toLowerCase()));
    return w;
  }
  if (family === 'accessoryCircular') {
    w.addSpacer();
    const mark = w.addText(view.error ? '?' : bad ? String(b.bad) : 'OK');
    mark.font = Font.boldSystemFont(20);
    mark.centerAlignText();
    const tag = w.addText(view.error ? 'no data' : bad ? 'down' : 'RSVX');
    tag.font = Font.systemFont(9);
    tag.centerAlignText();
    w.addSpacer();
    return w;
  }
  const head = w.addText('RSVX  ' + headline(view));
  head.font = Font.boldSystemFont(13);
  head.lineLimit = 1;
  let detail;
  if (view.error) detail = view.error;
  else if (bad) detail = b.failures.slice(0, 3).map((f) => f.name).join(', ') + (b.bad > 3 ? ' +' + (b.bad - 3) : '');
  else detail = b.bars.slice(0, 3).map((x) => x.label.replace(/^Disk.*/, 'Disk') + ' ' + Math.round(x.value) + '%').join('  ');
  const sub = w.addText(detail);
  sub.font = Font.systemFont(11);
  sub.lineLimit = 2;
  sub.minimumScaleFactor = 0.8;
  return w;
}

function buildWidget(view, family) {
  if (String(family).startsWith('accessory')) return lockWidget(view, family);
  if (family === 'small') return smallWidget(view);
  return mediumWidget(view); // medium, and large until it gets its own layout
}

// ---- run -----------------------------------------------------------------

async function main() {
  if (config.runsInApp) {
    const menu = new Alert();
    menu.title = 'RSVX Status';
    menu.addAction('Preview small widget');
    menu.addAction('Preview medium widget');
    menu.addAction('Change board address or password');
    menu.addCancelAction('Close');
    const hasUrl = !!boardUrl();
    const choice = hasUrl ? await menu.presentSheet() : 2;
    if (choice === -1) return;
    if (choice === 2 && !(await askSettings())) return;
    const view = await load();
    if (choice === 0) await buildWidget(view, 'small').presentSmall();
    else await buildWidget(view, 'medium').presentMedium();
    return;
  }
  const view = await load();
  Script.setWidget(buildWidget(view, config.widgetFamily || 'medium'));
}

// What to draw: the fresh answer, or the last good one plus why this one failed.
async function load() {
  const result = await fetchBoard();
  if (result.board) {
    writeCache(result.board);
    return { board: result.board, error: '', state: result.board.overall };
  }
  return { board: readCache(), error: result.error, state: 'down' };
}

await main();
Script.complete();
