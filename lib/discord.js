'use strict';

// Discord. Two things go to the webhook:
//   1. One "board" message with everything on it, edited in place every cycle.
//   2. A separate alert message whenever something fails, errors or recovers.

const os = require('os');
const store = require('./store');

const ICON = { ok: '🟢', warn: '🟡', down: '🔴', pending: '🔵', idle: '⚪' };
const COLOUR = { ok: 0x3fb950, warn: 0xd9a520, down: 0xe5484d };
const GROUPS = [['vps', 'VPS'], ['render', 'Render'], ['github', 'GitHub'], ['sites', 'Websites and SSL']];

const hook = () => process.env.DISCORD_WEBHOOK_URL;
const enabled = () => !!hook();

async function call(method, url, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(10000, (body.retry_after || 1) * 1000 + 250)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Discord ${res.status} ${text.slice(0, 120)}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Discord rate limit');
}

const clean = (s) => String(s == null ? '' : s).replace(/[`*_~|>]/g, (m) => `\\${m}`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Join lines up to a character budget, ending with "+N more" if some were cut.
function fit(lines, budget) {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (used + lines[i].length + 1 > budget - 14) { out.push(`+${lines.length - i} more`); break; }
    out.push(lines[i]);
    used += lines[i].length + 1;
  }
  return out.join('\n');
}

const row = (c) => `${ICON[c.status]} **${clean(c.name)}** ${clean(clip(c.summary || '', 110))}`;
const worst = (list) => (list.some((c) => c.status === 'down') ? 'down' : list.some((c) => c.status === 'warn') ? 'warn' : 'ok');
const bar = (v) => { const n = Math.max(0, Math.min(10, Math.round(v / 10))); return `${'▰'.repeat(n)}${'▱'.repeat(10 - n)}`; };

function board(snap, pageUrl) {
  const by = (g) => snap.checks.filter((c) => c.group === g);
  const bad = snap.checks.filter((c) => store.BAD.has(c.status));
  const total = snap.checks.filter((c) => c.status !== 'idle').length;
  const stamp = Math.floor(snap.generatedAt / 1000);
  const embeds = [];

  const head = {
    title: bad.length ? `${ICON[snap.overall]} ${bad.length} thing${bad.length === 1 ? '' : 's'} need${bad.length === 1 ? 's' : ''} attention` : '🟢 All systems running',
    color: COLOUR[snap.overall],
    description: `${total - bad.length} of ${total} checks passing · last checked <t:${stamp}:T> (<t:${stamp}:R>)`,
    fields: [],
  };
  if (pageUrl) head.url = pageUrl;
  if (bad.length) head.fields.push({ name: 'Needs attention', value: fit(bad.map(row), 1024) });
  embeds.push(head);

  // VPS
  const vps = by('vps');
  if (vps.length) {
    const host = vps.find((c) => c.kind === 'host');
    const svc = vps.filter((c) => c.kind === 'service');
    const repos = vps.filter((c) => c.kind === 'repo');
    const e = { title: `VPS · ${clean(host ? host.name : os.hostname())}`, color: COLOUR[worst(vps)], fields: [] };
    if (host) {
      e.description = `${ICON[host.status]} ${clean(host.summary)}`;
      for (const b of host.bars || []) {
        e.fields.push({ name: b.label, value: `${bar(b.value)} ${Math.round(b.value)}%\n${b.text || ''}`, inline: true });
      }
    }
    if (svc.length) e.fields.push({ name: 'Services', value: fit(svc.map(row), 1024) });
    if (repos.length) {
      const off = repos.filter((c) => c.status !== 'ok');
      const lines = off.map(row);
      lines.push(`${ICON.ok} ${repos.length - off.length} of ${repos.length} repos OK`);
      e.fields.push({ name: 'Repos on the VPS', value: fit(lines, 1024) });
    }
    embeds.push(e);
  }

  // Render
  const render = by('render');
  if (render.length) {
    embeds.push({ title: 'Render', color: COLOUR[worst(render)], description: fit(render.map((c) => `${row(c)}${c.meta && c.status !== 'idle' ? ` · ${c.meta}` : ''}`), 1500) });
  }

  // GitHub
  const gh = by('github');
  if (gh.length) {
    const off = gh.filter((c) => c.status !== 'ok' && c.status !== 'idle');
    const withFlows = gh.filter((c) => c.kind === 'workflows');
    const latest = gh.filter((c) => c.status === 'ok').sort((a, b) => b.sort - a.sort).slice(0, 5);
    const e = { title: 'GitHub', color: COLOUR[worst(gh)], fields: [] };
    e.description = gh.length === 1 && gh[0].status === 'idle'
      ? row(gh[0])
      : `${gh.length} repos · ${withFlows.length} with workflows · ${gh.filter((c) => c.status === 'down').length} failing`;
    if (off.length) e.fields.push({ name: 'Workflows', value: fit(off.map(row), 1024) });
    if (latest.length && gh[0].status !== 'idle') e.fields.push({ name: 'Latest pushes', value: fit(latest.map((c) => `${row(c)} · ${c.meta}`), 1024) });
    embeds.push(e);
  }

  // Websites
  const sites = by('sites');
  if (sites.length) embeds.push({ title: 'Websites and SSL', color: COLOUR[worst(sites)], description: fit(sites.map(row), 1200) });

  embeds[embeds.length - 1].footer = { text: 'RSVX Status · rhys@rsvx.co.uk' };
  return { username: 'RSVX Status', content: '', embeds, allowed_mentions: { parse: [] } };
}

let lastBoardError = 0;

async function updateBoard(snap, pageUrl) {
  if (!enabled()) return;
  const payload = board(snap, pageUrl);
  const id = store.getSaved('boardMessageId');
  try {
    if (id) {
      try {
        await call('PATCH', `${hook()}/messages/${id}`, payload);
        return;
      } catch (e) {
        if (e.status !== 404) throw e; // 404: the message was deleted, post a new one
      }
    }
    const msg = await call('POST', `${hook()}?wait=true`, payload);
    if (msg && msg.id) store.setSaved('boardMessageId', msg.id);
  } catch (e) {
    if (Date.now() - lastBoardError > 10 * 60 * 1000) { console.error('board update failed:', e.message); lastBoardError = Date.now(); }
  }
}

function label(group) {
  const g = GROUPS.find((x) => x[0] === group);
  return g ? g[1] : group;
}

// changes: [{ name, group, to, summary, url }]
async function sendAlert(changes, pageUrl, title) {
  if (!enabled() || !changes.length) return;
  const failed = changes.filter((c) => store.BAD.has(c.to));
  const fixed = changes.filter((c) => c.to === 'ok');
  const line = (c) => `${ICON[c.to]} **${clean(c.name)}** (${label(c.group)})\n${clean(clip(c.summary || '', 200))}${c.url ? `\n<${c.url}>` : ''}`;
  const embeds = [];
  if (failed.length) {
    const level = failed.some((c) => c.to === 'down') ? 'down' : 'warn';
    embeds.push({
      title: title || (level === 'down' ? `🔴 ${failed.length} failure${failed.length === 1 ? '' : 's'}` : `🟡 ${failed.length} warning${failed.length === 1 ? '' : 's'}`),
      color: COLOUR[level], description: fit(failed.map(line), 3500), timestamp: new Date().toISOString(),
    });
  }
  if (fixed.length) {
    embeds.push({ title: `🟢 Recovered: ${fixed.length}`, color: COLOUR.ok, description: fit(fixed.map(line), 2000), timestamp: new Date().toISOString() });
  }
  if (pageUrl) embeds[0].url = pageUrl;
  const mention = failed.some((c) => c.to === 'down') ? (process.env.DISCORD_MENTION || '') : '';
  try {
    await call('POST', hook(), { username: 'RSVX Status', content: mention, embeds, allowed_mentions: { parse: ['users', 'roles'] } });
  } catch (e) {
    console.error('alert failed:', e.message);
  }
}

module.exports = { updateBoard, sendAlert, board, enabled };
