'use strict';

// Holds the current result of every check, works out when something has
// really changed (two bad readings in a row, so one blip doesn't ping Discord)
// and keeps a short log of changes. A little state is saved to data/state.json
// so a restart keeps the same Discord message and the same history.

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./util');

const FILE = path.join(ROOT, 'data', 'state.json');
const BAD = new Set(['down', 'warn']);
const checks = new Map();
let saved = { events: [], boardMessageId: null, secret: null };

try { saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
const events = saved.events || [];
const MAX_EVENTS = 80;

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ ...saved, events }, null, 1));
  } catch (e) {
    console.error('could not save state:', e.message);
  }
}

function getSaved(key) { return saved[key]; }
function setSaved(key, value) { saved[key] = value; save(); }

// Replace every check in `bucket` with `list`. Returns the changes worth alerting on.
function apply(bucket, list, now = Date.now()) {
  const changes = [];
  const seen = new Set();

  for (const c of list) {
    seen.add(c.id);
    const prev = checks.get(c.id);
    const next = { ...c, bucket, checkedAt: now };

    if (!prev) {
      Object.assign(next, { confirmed: c.status, since: now, streak: 0, alerted: false, candidate: null });
      checks.set(c.id, next);
      continue;
    }

    Object.assign(next, { confirmed: prev.confirmed, since: prev.since, alerted: prev.alerted, candidate: prev.candidate, streak: prev.streak || 0 });

    if (c.status === prev.confirmed) {
      next.candidate = null;
      next.streak = 0;
    } else {
      if (c.status === prev.candidate) next.streak += 1;
      else { next.candidate = c.status; next.streak = 1; }
      const need = BAD.has(c.status) ? 2 : 1;
      if (next.streak >= need) {
        const from = prev.confirmed;
        Object.assign(next, { confirmed: c.status, since: now, candidate: null, streak: 0 });
        if (BAD.has(c.status)) {
          next.alerted = true;
          changes.push(change(next, from, now));
        } else if (c.status === 'ok' && prev.alerted) {
          next.alerted = false;
          changes.push(change(next, from, now));
        }
      }
    }
    checks.set(c.id, next);
  }

  for (const [id, c] of checks) {
    if (c.bucket === bucket && !seen.has(id)) checks.delete(id);
  }
  if (changes.length) {
    for (const ch of changes) events.unshift(ch);
    events.length = Math.min(events.length, MAX_EVENTS);
    save();
  }
  return changes;
}

function change(c, from, now) {
  return { t: now, id: c.id, group: c.group, name: c.name, from, to: c.confirmed, summary: c.summary, url: c.url || null };
}

// Problems that already exist the first time we look. Marked so their recovery is reported.
function existingProblems() {
  const out = [];
  for (const c of checks.values()) {
    if (BAD.has(c.status)) { c.alerted = true; c.confirmed = c.status; out.push(c); }
  }
  return out;
}

const ORDER = { down: 0, warn: 1, pending: 2, ok: 3, idle: 4 };

function snapshot() {
  const list = [...checks.values()].map((c) => ({
    id: c.id, group: c.group, name: c.name, status: c.status, summary: c.summary,
    meta: c.meta || null, url: c.url || null, since: c.since, sort: c.sort || 0,
    recent: c.recent !== false, bars: c.bars || null, kind: c.kind || null,
  })).sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || (b.sort - a.sort) || a.name.localeCompare(b.name));
  const counts = { ok: 0, warn: 0, down: 0, pending: 0, idle: 0 };
  for (const c of list) counts[c.status] = (counts[c.status] || 0) + 1;
  const overall = counts.down ? 'down' : counts.warn ? 'warn' : 'ok';
  return { generatedAt: Date.now(), overall, counts, checks: list, events: events.slice(0, 40) };
}

module.exports = { apply, snapshot, existingProblems, getSaved, setSaved, BAD };
