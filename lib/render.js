'use strict';

// Render: every service, the state of its latest deploy, whether that deploy
// matches the newest commit on GitHub, and whether the URL answers.

const { fetchJson, pool, ago, repoKey, short, list } = require('./util');
const github = require('./github');

const api = () => process.env.RENDER_API || 'https://api.render.com/v1';
const GRACE_MS = 10 * 60 * 1000; // how long Render gets to pick up a new commit

const IN_PROGRESS = new Set(['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']);
const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed']);
const SKIP = new Set(['canceled', 'deactivated']);

const headers = () => ({ Authorization: `Bearer ${process.env.RENDER_API_KEY}`, Accept: 'application/json' });

async function listServices() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const rows = await fetchJson(`${api()}/services?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { headers: headers() });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows.map((r) => r.service).filter(Boolean));
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].cursor;
  }
  return out;
}

async function ping(url) {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'rsvx-status' } });
    return { ok: res.status < 500, code: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, code: 0, error: e.name === 'TimeoutError' ? 'timed out' : (e.cause && e.cause.code) || e.message };
  }
}

async function checkService(s, now) {
  const d = s.serviceDetails || {};
  const kind = String(s.type || '').replace(/_/g, ' ');
  const base = { id: `render:${s.id}`, group: 'render', name: s.name, url: s.dashboardUrl, sort: Date.parse(s.updatedAt) || 0, kind };

  if (s.suspended === 'suspended') {
    return { ...base, status: 'idle', summary: 'Suspended', meta: kind };
  }

  const rows = await fetchJson(`${api()}/services/${s.id}/deploys?limit=5`, { headers: headers() });
  const deploys = (rows || []).map((r) => r.deploy).filter((x) => x && !SKIP.has(x.status));
  const latest = deploys[0];
  const commit = latest && latest.commit ? latest.commit : null;
  const when = latest ? Date.parse(latest.finishedAt || latest.updatedAt || latest.createdAt) : null;
  const meta = latest ? `deployed ${ago(now - when)} ago` : 'no deploys';

  if (latest && FAILED.has(latest.status)) {
    return { ...base, status: 'down', summary: `Deploy failed (${latest.status.replace(/_/g, ' ')})${commit ? ` on ${short(commit.id)}` : ''}`, meta };
  }
  if (latest && IN_PROGRESS.has(latest.status)) {
    return { ...base, status: 'pending', summary: `Deploying${commit ? ` ${short(commit.id)}` : ''}`, meta: 'in progress' };
  }

  const notes = [];
  let status = 'ok';

  // Is the URL answering? Free web services sleep when idle and pinging them
  // would keep them awake and burn free hours, so those are left alone.
  const sleeps = s.type === 'web_service' && d.plan === 'free';
  if (d.url && !sleeps && (s.type === 'web_service' || s.type === 'static_site')) {
    const p = await ping(d.url);
    if (!p.ok) {
      return { ...base, status: 'down', summary: p.code ? `Site returned ${p.code}` : `Site not responding (${p.error})`, meta, url: d.url };
    }
    notes.push(`${p.code} in ${p.ms}ms`);
  } else if (sleeps) {
    notes.push('free plan, not pinged');
  }

  // Did Render pick up the newest commit?
  const head = github.heads.get(repoKey(s.repo) || '');
  if (s.autoDeploy !== 'yes') {
    notes.push('auto-deploy off');
  } else if (head && commit && !s.rootDir && s.branch === head.branch && head.sha !== commit.id && now - head.committedAt > GRACE_MS) {
    status = 'warn';
    notes.unshift(`Behind GitHub: live ${short(commit.id)}, newest ${short(head.sha)} pushed ${ago(now - head.committedAt)} ago`);
  } else if (commit) {
    notes.unshift(`Live on ${short(commit.id)}`);
  }

  return { ...base, status, summary: notes.join(' · ') || 'Live', meta };
}

async function collect(now = Date.now()) {
  const skip = new Set(list(process.env.IGNORE_SERVICES).map((s) => s.toLowerCase()));
  const services = (await listServices()).filter((s) => !skip.has(String(s.name).toLowerCase()));
  const results = await pool(services, 4, (s) => checkService(s, now));
  return results.map((r, i) => (r && r.error
    ? { id: `render:${services[i].id}`, group: 'render', name: services[i].name, status: 'warn', summary: `Could not check: ${r.error.message}`, url: services[i].dashboardUrl }
    : r));
}

module.exports = { collect, ping, enabled: () => !!process.env.RENDER_API_KEY, missing: 'Add RENDER_API_KEY to .env' };
