'use strict';

// RSVX Status
// Runs on the VPS. Every minute it checks the VPS itself, Render, GitHub and
// your websites, serves one page with the result, keeps one Discord message
// up to date and posts an alert when something fails or recovers.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadEnv, ROOT } = require('./lib/util');

loadEnv(path.join(ROOT, '.env'));

const store = require('./lib/store');
const discord = require('./lib/discord');
const collectors = {
  github: require('./lib/github'),
  vps: require('./lib/vps'),
  render: require('./lib/render'),
  sites: require('./lib/sites'),
};
const LABEL = { github: 'GitHub', vps: 'VPS', render: 'Render', sites: 'Websites' };

const PORT = Number(process.env.PORT) || 8787;
const INTERVAL = Math.max(process.env.TEST_FAST ? 1 : 30, Number(process.env.CHECK_INTERVAL) || 60) * 1000;
const PAGE_URL = process.env.PUBLIC_URL || '';

// ---- the check loop ------------------------------------------------------

let cycles = 0;
let running = false;

async function runGroup(name, now) {
  const c = collectors[name];
  if (!c.enabled()) {
    store.apply(name, [{ id: `${name}:off`, group: name, name: LABEL[name], status: 'idle', summary: `Not connected. ${c.missing}` }], now);
    return [];
  }
  try {
    const list = await c.collect(now);
    const changes = store.apply(name, list, now);
    return changes.concat(store.apply(`${name}:error`, [], now));
  } catch (e) {
    // Keep the last known results and show that this source could not be read.
    return store.apply(`${name}:error`, [{ id: `${name}:error`, group: name, name: `${LABEL[name]} check`, status: 'down', summary: `Could not read ${LABEL[name]}: ${e.message}` }], now);
  }
}

async function cycle() {
  if (running) return;
  running = true;
  const now = Date.now();
  try {
    let changes = [];
    // GitHub first (every other cycle): Render and the VPS compare against its commits.
    if (cycles % 2 === 0) changes = changes.concat(await runGroup('github', now));
    const rest = await Promise.all(['vps', 'render', 'sites'].map((g) => runGroup(g, now)));
    changes = changes.concat(...rest);

    if (cycles === 0) {
      const existing = store.existingProblems().map((c) => ({ name: c.name, group: c.group, to: c.status, summary: c.summary, url: c.url }));
      if (existing.length) await discord.sendAlert(existing, PAGE_URL, `Status board started: ${existing.length} existing problem${existing.length === 1 ? '' : 's'}`);
    } else if (changes.length) {
      await discord.sendAlert(changes, PAGE_URL);
    }
    await discord.updateBoard(store.snapshot(), PAGE_URL);

    if (process.env.HEARTBEAT_URL) {
      fetch(process.env.HEARTBEAT_URL, { signal: AbortSignal.timeout(10000) }).catch(() => {});
    }
  } catch (e) {
    console.error('cycle failed:', e);
  } finally {
    cycles += 1;
    running = false;
  }
}

// ---- page login ----------------------------------------------------------

let secret = store.getSaved('secret');
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); store.setSaved('secret', secret); }

const sign = (exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
const attempts = new Map();

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function loggedIn(req) {
  if (!process.env.STATUS_PASSWORD) return true;
  const m = /(?:^|;\s*)rsvx_status=(\d+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return !!m && Number(m[1]) > Date.now() && safeEqual(m[2], sign(m[1]));
}

function tooMany(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 8;
}

// ---- http ----------------------------------------------------------------

const PUBLIC = path.join(ROOT, 'public');
const page = (name) => fs.readFileSync(path.join(PUBLIC, name));

function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...extra,
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

    if (url.pathname === '/login' && req.method === 'POST') {
      if (tooMany(ip)) return send(res, 429, 'Too many attempts. Try again in a few minutes.', 'text/plain');
      const form = new URLSearchParams(await readBody(req));
      if (process.env.STATUS_PASSWORD && safeEqual(form.get('password') || '', process.env.STATUS_PASSWORD)) {
        const exp = Date.now() + 30 * 24 * 3600 * 1000;
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 303, '', 'text/plain', {
          Location: '/', 'Set-Cookie': `rsvx_status=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
        });
      }
      attempts.get(ip).push(Date.now());
      return send(res, 303, '', 'text/plain', { Location: '/login?wrong=1' });
    }
    if (url.pathname === '/login') return send(res, 200, page('login.html'));
    if (url.pathname === '/logout') {
      return send(res, 303, '', 'text/plain', { Location: '/login', 'Set-Cookie': 'rsvx_status=; Path=/; Max-Age=0' });
    }

    if (!loggedIn(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, '{"error":"login required"}', 'application/json');
      return send(res, 303, '', 'text/plain', { Location: '/login' });
    }

    if (url.pathname === '/api/status') {
      return send(res, 200, JSON.stringify({ ...store.snapshot(), ready: cycles > 0, interval: INTERVAL }), 'application/json');
    }
    if (url.pathname === '/api/recheck' && req.method === 'POST') {
      cycle();
      return send(res, 202, '{"ok":true}', 'application/json');
    }
    if (url.pathname === '/') return send(res, 200, page('index.html'));
    return send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    return send(res, 500, 'Something went wrong', 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log(`RSVX Status on port ${PORT}`);
  if (!process.env.STATUS_PASSWORD) console.log('WARNING: STATUS_PASSWORD is not set, the page is open to anyone who can reach this port.');
  cycle();
  setInterval(cycle, INTERVAL);
});
