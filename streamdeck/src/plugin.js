'use strict';

// RSVX Status for Stream Deck.
// Stream Deck starts this file and talks to it over a local WebSocket.
// Four key types read the RSVX Status board and redraw themselves:
//   overall  - is everything running (press: open the board)
//   load     - CPU / RAM / disk of the server (press: check now)
//   service  - one watched service, e.g. FiveM (press: check now)
//   failure  - what failed (press: next failure)
//
// Contact: rhys@rsvx.co.uk

const WebSocket = require('ws');
const { makeClient } = require('./board');
const draw = require('./keys');

const ID = 'com.rsvx.status';
const ACTION = { overall: `${ID}.overall`, load: `${ID}.load`, service: `${ID}.service`, failure: `${ID}.failure` };

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? '' : process.argv[i + 1];
}
const port = arg('-port');
const pluginUUID = arg('-pluginUUID');
const registerEvent = arg('-registerEvent');

const client = makeClient();
const keys = new Map(); // context -> { action, settings, index, last }
let globals = {};       // boardUrl, password, refreshSeconds
let view = { board: null, error: '' };
let timer = null;
let reading = false;
let again = false;

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const send = (event, context, payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, context, payload }));
};
const log = (message) => send('logMessage', undefined, { message: `RSVX Status: ${message}` });

function image(k) {
  if (k.action === ACTION.overall) return draw.overall(view);
  if (k.action === ACTION.load) return draw.load(view, k.settings);
  if (k.action === ACTION.service) return draw.service(view, k.settings);
  return draw.failure(view, k.index);
}

function render(context) {
  const k = keys.get(context);
  if (!k) return;
  const img = image(k);
  if (img === k.last) return; // nothing changed: do not resend the same picture
  k.last = img;
  send('setImage', context, { image: img, target: 0 });
}
const renderAll = () => { for (const context of keys.keys()) render(context); };

async function refresh() {
  if (reading) { again = true; return; }
  reading = true;
  try {
    const result = await client.read(String(globals.boardUrl || '').trim().replace(/\/+$/, ''), String(globals.password || ''));
    const was = view.error;
    if (result.board) view = { board: result.board, error: '' };
    else view = { board: view.board, error: result.error };
    if (view.error && view.error !== was) log(`could not read the board (${view.error})`);
    renderAll();
  } catch (e) {
    log(`refresh failed: ${e && e.message}`);
  } finally {
    reading = false;
    if (again) { again = false; refresh(); }
  }
}

// Only poll while at least one key is on screen.
function schedule() {
  clearInterval(timer);
  timer = null;
  if (!keys.size) return;
  const seconds = Math.max(5, Math.min(3600, Number(globals.refreshSeconds) || 15));
  timer = setInterval(refresh, seconds * 1000);
}

function serviceNames() {
  return view.board ? view.board.services.map((s) => s.name) : [];
}

const handlers = {
  willAppear(m) {
    const fresh = !keys.size;
    keys.set(m.context, { action: m.action, settings: (m.payload && m.payload.settings) || {}, index: 0, last: '' });
    render(m.context);
    if (fresh) { schedule(); refresh(); }
  },
  willDisappear(m) {
    keys.delete(m.context);
    if (!keys.size) schedule();
  },
  didReceiveSettings(m) {
    const k = keys.get(m.context);
    if (!k) return;
    k.settings = (m.payload && m.payload.settings) || {};
    render(m.context);
  },
  didReceiveGlobalSettings(m) {
    const next = (m.payload && m.payload.settings) || {};
    if (next.boardUrl !== globals.boardUrl || next.password !== globals.password) {
      client.reset();
      view = { board: null, error: '' };
    }
    globals = next;
    schedule();
    renderAll();
    if (keys.size) refresh();
  },
  keyDown(m) {
    const k = keys.get(m.context);
    if (!k) return;
    if (k.action === ACTION.overall) {
      const url = String(globals.boardUrl || '').trim();
      if (/^https?:\/\//i.test(url)) send('openUrl', undefined, { url });
      else send('showAlert', m.context);
    } else if (k.action === ACTION.failure && view.board && view.board.failures.length > 1) {
      k.index = (k.index + 1) % view.board.failures.length;
      render(m.context);
    } else {
      refresh();
    }
  },
  // The settings panel asks which services exist so it can offer a list.
  sendToPlugin(m) {
    if (m.payload && m.payload.type === 'services') {
      ws.send(JSON.stringify({ action: m.action, event: 'sendToPropertyInspector', context: m.context, payload: { type: 'services', names: serviceNames(), error: view.error } }));
    }
  },
};

ws.on('open', () => {
  ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
  send('getGlobalSettings', pluginUUID);
});
ws.on('message', (data) => {
  let m;
  try { m = JSON.parse(data.toString()); } catch (e) { return; }
  const h = handlers[m.event];
  if (!h) return;
  try { h(m); } catch (e) { log(`${m.event} failed: ${e && e.message}`); }
});
ws.on('close', () => process.exit(0));
ws.on('error', () => process.exit(1));
process.on('uncaughtException', (e) => log(`error: ${e && e.message}`));
process.on('unhandledRejection', (e) => log(`error: ${e && e.message}`));
