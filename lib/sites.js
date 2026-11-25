'use strict';

// Websites: does each one answer, and how long until its SSL certificate runs out.
// SITES="Dom-NOD|https://example.co.uk, https://another.co.uk"

const tls = require('tls');
const { pool, list } = require('./util');
const { ping } = require('./render');

function parse() {
  return list(process.env.SITES).map((entry) => {
    const [a, b] = entry.split('|').map((x) => x.trim());
    let url = b || a;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`; // bare domains are fine
    let host = url;
    let port = 443;
    try { const u = new URL(url); host = u.hostname; port = Number(u.port) || 443; } catch { /* leave as typed */ }
    return { name: b ? a : host, url, host, port };
  });
}

function certDaysLeft(host, port) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) return resolve({ error: 'no certificate' });
      resolve({ days: Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400000) });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ error: 'timed out' }); });
    sock.on('error', (e) => resolve({ error: e.code || e.message }));
  });
}

async function collect() {
  const out = [];
  await pool(parse(), 4, async (s) => {
    const p = await ping(s.url);
    out.push({
      id: `site:${s.host}`, group: 'sites', name: s.name, url: s.url, kind: 'site',
      status: p.ok ? 'ok' : 'down',
      summary: p.ok ? `Responding · ${p.code} in ${p.ms}ms` : (p.code ? `Returned ${p.code}` : `Not responding (${p.error})`),
    });
    if (!s.url.startsWith('https://')) return;
    const c = await certDaysLeft(s.host, s.port);
    let status = 'ok';
    let summary;
    if (c.error) { status = 'warn'; summary = `Could not read certificate (${c.error})`; }
    else if (c.days < 0) { status = 'down'; summary = `Certificate expired ${-c.days} days ago`; }
    else if (c.days <= 3) { status = 'down'; summary = `Certificate expires in ${c.days} days`; }
    else if (c.days <= 14) { status = 'warn'; summary = `Certificate expires in ${c.days} days`; }
    else summary = `Certificate valid for ${c.days} more days`;
    out.push({ id: `ssl:${s.host}`, group: 'sites', name: `${s.name} SSL`, url: s.url, status, summary, kind: 'ssl' });
  });
  return out;
}

module.exports = { collect, enabled: () => parse().length > 0, missing: 'Add your website addresses to SITES in .env' };
