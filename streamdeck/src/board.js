'use strict';

// Reads the RSVX Status board: logs in with the page password, keeps the
// cookie, and boils the answer down to what the keys show.

const TIMEOUT = 6000;

function makeClient() {
  let cookie = '';
  let noLoginUntil = 0; // after a refused password, wait before trying again
  let loginError = '';

  async function call(url, options = {}) {
    try {
      const res = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      return { reached: true, status: res.status, res };
    } catch (e) {
      return { reached: false };
    }
  }

  const getStatus = (base) => call(`${base}/api/status`, { headers: cookie ? { Cookie: cookie } : {} });

  // Returns { board } or { error: short reason shown on the key }.
  async function read(base, password) {
    if (!/^https?:\/\/[^/\s]+/i.test(base || '') || base.includes('your-server')) return { error: 'SET UP' };

    let r = await getStatus(base);
    if (r.reached && r.status === 401) {
      if (!password) return { error: 'PASSWORD' };
      if (Date.now() < noLoginUntil) return { error: loginError };

      const login = await call(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(password)}`,
      });
      if (!login.reached) return { error: 'NO ANSWER' };
      const set = (login.res.headers.getSetCookie ? login.res.headers.getSetCookie() : [])
        .map((c) => c.split(';')[0]).find((c) => c.startsWith('rsvx_status=') && c.length > 'rsvx_status='.length);
      if (!set) {
        // The board allows 8 tries in 10 minutes, so do not hammer it.
        noLoginUntil = Date.now() + 5 * 60 * 1000;
        loginError = login.status === 429 ? 'LOCKED OUT' : 'PASSWORD';
        return { error: loginError };
      }
      cookie = set;
      r = await getStatus(base);
    }
    if (!r.reached) return { error: 'NO ANSWER' };
    if (r.status !== 200) return { error: `HTTP ${r.status}` };
    try {
      return { board: summarise(await r.res.json()) };
    } catch (e) {
      return { error: 'BAD DATA' };
    }
  }

  // New address or password: forget the old login.
  function reset() {
    cookie = '';
    noLoginUntil = 0;
  }

  return { read, reset };
}

const GROUP = { vps: 'VPS', render: 'RENDER', github: 'GITHUB', sites: 'WEB' };

function summarise(d) {
  if (!d || !Array.isArray(d.checks)) throw new Error('no checks');
  const live = d.checks.filter((c) => c.status !== 'idle');
  const failures = live.filter((c) => c.status === 'down' || c.status === 'warn')
    .sort((a, b) => (a.status === 'down' ? 0 : 1) - (b.status === 'down' ? 0 : 1))
    .map((c) => ({ name: String(c.name || ''), group: GROUP[c.group] || '', state: c.status }));
  const host = d.checks.find((c) => c.group === 'vps' && c.kind === 'host');
  const bars = ((host && host.bars) || []).map((b) => ({
    label: String(b.label || ''), value: Math.max(0, Math.min(100, Number(b.value) || 0)),
  }));
  const services = d.checks.filter((c) => c.group === 'vps' && c.kind === 'service')
    .map((c) => ({ name: String(c.name || ''), state: c.status }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const overall = !d.ready ? 'pending' : failures.some((f) => f.state === 'down') ? 'down' : failures.length ? 'warn' : 'ok';
  return { ready: !!d.ready, live: live.length, bad: failures.length, overall, failures, bars, services };
}

module.exports = { makeClient, summarise };
