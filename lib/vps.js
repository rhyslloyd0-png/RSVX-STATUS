'use strict';

// The VPS this runs on: CPU, memory, disk, the services it is told to watch,
// and every git repo it can find compared against the newest commit on GitHub.

const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { run, ago, repoKey, short, list, pool } = require('./util');
const github = require('./github');

const GRACE_MS = 10 * 60 * 1000; // how long the VPS gets to pull a new commit
const NAME = () => process.env.VPS_NAME || os.hostname();
const size = (bytes) => (bytes >= 10 * 1073741824 ? `${Math.round(bytes / 1073741824)} GB` : bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`);

// ---- resources -----------------------------------------------------------

function cpuTimes() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}

async function cpuPercent() {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, 500));
  const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? 100 * (1 - (b.idle - a.idle) / total) : 0;
}

function memory() {
  const total = os.totalmem();
  let available = os.freemem();
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    if (m) available = Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return { total, available };
}

async function disks() {
  const r = await run('df', ['-Pk']);
  if (r.err && !r.out) return [];
  const seen = new Set();
  const out = [];
  for (const line of r.out.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6 || !p[0].startsWith('/dev/')) continue;
    const mount = p.slice(5).join(' ');
    if (seen.has(p[0]) || /^\/(boot|snap|run|var\/lib\/docker)/.test(mount)) continue;
    seen.add(p[0]);
    if (Number(p[1]) < 1048576) continue; // ignore mounts under 1 GB
    out.push({ mount, total: Number(p[1]) * 1024, used: Number(p[2]) * 1024 });
  }
  return out.slice(0, 4);
}

// ---- services ------------------------------------------------------------

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 3000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

const wanted = (v) => !/^(false|off|no|0)$/i.test(String(v || 'auto'));

async function services() {
  const out = [];

  for (const unit of list(process.env.WATCH_SYSTEMD)) {
    const r = await run('systemctl', ['is-active', unit]);
    out.push({ type: 'systemd', name: unit, ok: r.out === 'active', state: r.out || 'unknown' });
  }

  for (const entry of list(process.env.WATCH_PORTS)) {
    const [a, b] = entry.split(':');
    const port = Number(b || a);
    if (!port) continue;
    const ok = await portOpen(port);
    out.push({ type: 'port', name: b ? a : `port ${port}`, ok, state: ok ? `:${port} open` : `nothing listening on :${port}` });
  }

  if (wanted(process.env.WATCH_PM2)) {
    const r = await run('pm2', ['jlist']);
    if (!r.err) {
      try {
        const start = r.out.indexOf('[');
        for (const p of JSON.parse(r.out.slice(start))) {
          const state = p.pm2_env && p.pm2_env.status;
          out.push({ type: 'pm2', name: p.name, ok: state === 'online', state });
        }
      } catch { /* pm2 printed something unexpected */ }
    }
  }

  if (wanted(process.env.WATCH_DOCKER)) {
    const r = await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}']);
    if (!r.err && r.out) {
      for (const line of r.out.split('\n')) {
        const [name, state] = line.split('\t');
        if (name) out.push({ type: 'docker', name, ok: state === 'running', state });
      }
    }
  }
  return out;
}

// ---- git repos -----------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'cache', '.cache', '.npm', '.nvm', '.pm2', 'vendor', 'dist', 'build', 'proc', 'sys', 'dev', 'tmp', 'snap', 'lib', 'logs']);
let found = { at: 0, dirs: [] };

function walk(dir, depth, out) {
  if (out.length >= 80) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.name === '.git')) { out.push(dir); return; } // don't look inside a repo
  if (depth <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.') && e.name !== '.') continue;
    walk(path.join(dir, e.name), depth - 1, out);
  }
}

function findRepos(now) {
  if (now - found.at < 10 * 60 * 1000) return found.dirs;
  const dirs = [];
  for (const root of list(process.env.REPO_ROOTS || '/home,/opt,/srv,/var/www,/root')) walk(root, 4, dirs);
  found = { at: now, dirs: [...new Set(dirs)] };
  return found.dirs;
}

async function gitState(dir) {
  const git = (...args) => run('git', ['-c', 'safe.directory=*', '-C', dir, ...args]);
  const head = await git('rev-parse', 'HEAD');
  if (head.err) return { path: dir, error: (head.stderr.split('\n')[0] || 'not readable').slice(0, 100) };
  const [branch, remote, status, ahead] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('config', '--get', 'remote.origin.url'),
    git('status', '--porcelain'),
    git('rev-list', '--count', '@{u}..HEAD'),
  ]);
  return {
    path: dir,
    sha: head.out,
    branch: branch.out,
    key: repoKey(remote.out), // only owner/repo is kept; any token in the URL is dropped
    dirty: status.err ? 0 : status.out.split('\n').filter(Boolean).length,
    ahead: ahead.err ? 0 : Number(ahead.out) || 0,
  };
}

function repoCheck(g, host, now) {
  const head = g.key ? github.heads.get(g.key) : null;
  const c = {
    id: `vps:repo:${g.path}`, group: 'vps', kind: 'repo', status: 'ok', meta: g.path,
    name: path.basename(g.path) || g.path, url: head ? head.url : null,
  };
  const notes = [];
  if (g.error) {
    c.status = 'warn'; notes.push(`git error: ${g.error}`);
  } else if (g.ahead > 0) {
    c.status = 'warn'; notes.push(`${g.ahead} commit${g.ahead === 1 ? '' : 's'} not pushed to GitHub`);
  } else if (!head) {
    notes.push(`On ${short(g.sha)} (${g.branch})`);
  } else if (g.branch !== head.branch) {
    notes.push(`On branch ${g.branch} at ${short(g.sha)}`);
  } else if (g.sha === head.sha) {
    notes.push(`In sync with GitHub (${short(g.sha)})`);
  } else if (now - head.committedAt > GRACE_MS) {
    c.status = 'warn';
    notes.push(`Behind GitHub: VPS has ${short(g.sha)}, newest is ${short(head.sha)} pushed ${ago(now - head.committedAt)} ago`);
  } else {
    c.status = 'pending'; notes.push(`New commit ${short(head.sha)} not pulled yet`);
  }
  if (g.dirty > 0) notes.push(`${g.dirty} uncommitted file${g.dirty === 1 ? '' : 's'}`);
  c.summary = notes.join(' · ');
  return c;
}

// ---- collect -------------------------------------------------------------

async function collect(now = Date.now()) {
  const host = NAME();
  const [cpu, disk, svc] = await Promise.all([cpuPercent(), disks(), services()]);
  const mem = memory();
  const out = [];

  const problems = [];
  let status = 'ok';
  const bump = (s) => { if (s === 'down' || (s === 'warn' && status === 'ok')) status = s; };
  const bars = [{ label: 'CPU', value: cpu, text: `${os.cpus().length} cores · load ${os.loadavg()[0].toFixed(2)}` }];
  if (cpu >= 95) { bump('warn'); problems.push(`CPU ${Math.round(cpu)}%`); }

  const memUsed = 100 * (1 - mem.available / mem.total);
  bars.push({ label: 'RAM', value: memUsed, text: `${size(mem.total - mem.available)} of ${size(mem.total)}` });
  if (memUsed >= 92) { bump('warn'); problems.push(`RAM ${Math.round(memUsed)}%`); }

  for (const d of disk) {
    const used = d.total ? 100 * d.used / d.total : 0;
    bars.push({ label: `Disk ${d.mount}`, value: used, text: `${size(d.used)} of ${size(d.total)}` });
    if (used >= 95) { bump('down'); problems.push(`Disk ${d.mount} ${Math.round(used)}% full`); }
    else if (used >= 85) { bump('warn'); problems.push(`Disk ${d.mount} ${Math.round(used)}% full`); }
  }

  out.push({
    id: 'vps:host', group: 'vps', kind: 'host', name: host, status, bars, sort: 3,
    summary: problems.length ? problems.join(' · ') : `Online · up ${ago(os.uptime() * 1000)}`,
  });

  for (const s of svc) {
    out.push({
      id: `vps:svc:${s.type}:${s.name}`, group: 'vps', kind: 'service', name: s.name, sort: 2,
      status: s.ok ? 'ok' : 'down',
      summary: s.ok ? `Running (${s.type})` : `Not running (${s.type}: ${s.state || 'stopped'})`,
    });
  }

  const states = await pool(findRepos(now), 4, gitState);
  for (const g of states) {
    if (g && g.path) out.push({ ...repoCheck(g, host, now), sort: 1 });
  }
  return out;
}

module.exports = { collect, enabled: () => true, missing: '' };
