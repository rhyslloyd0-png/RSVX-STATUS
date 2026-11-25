'use strict';

// Small helpers shared by the checks.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Minimal .env reader so there are no dependencies to install.
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function timeout(ms) {
  return AbortSignal.timeout(ms);
}

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...opts, signal: timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && body.message ? body.message : String(text).slice(0, 120);
    const err = new Error(`${res.status} ${msg}`.trim());
    err.status = res.status;
    throw err;
  }
  return body;
}

// Run fn over items with a concurrency cap. A thrown error becomes { error }.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const n = i++;
      try { out[n] = await fn(items[n], n); } catch (e) { out[n] = { error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, out: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function ago(ms) {
  if (ms == null || isNaN(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// "https://x:token@github.com/Owner/Repo.git", "git@github.com:Owner/Repo" -> "owner/repo"
function repoKey(url) {
  if (!url) return null;
  const m = String(url).match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : '');
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ROOT = path.join(__dirname, '..');

module.exports = { loadEnv, fetchJson, pool, run, ago, repoKey, short, list, ROOT };
