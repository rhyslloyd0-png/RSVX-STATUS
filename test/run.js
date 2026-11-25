'use strict';

// End-to-end test against fake GitHub, Render and Discord servers.
// Starts the real server.js, lets it run a few cycles, breaks things on
// purpose and checks the right alerts and board edits reach "Discord".

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert');

const MOCK = 9911;
const APP = 9912;
const state = { deployStatus: 'live', workflowConclusion: 'success', siteCode: 200, posts: [], patches: [] };
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

const repos = ['WARD', 'Fivem', 'RSVX-SHOWCASE-SERVER', 'Dom-NOD', 'Old-Thing'].map((name, i) => ({
  name, nameWithOwner: `rhys/${name}`, url: `https://github.com/rhys/${name}`, isPrivate: true, isArchived: false,
  pushedAt: name === 'Old-Thing' ? iso(60 * 24 * 40) : iso(30 + i * 90),
  defaultBranchRef: { name: 'main', target: { oid: `${'abcdef0'.repeat(5)}${i}aaaa`, messageHeadline: `Update ${name} <b>*bold*</b>`, committedDate: iso(30 + i * 90) } },
}));

function json(res, body, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = req.url;
    if (u === '/gh/graphql') return json(res, { data: { viewer: { login: 'rhys', repositories: { pageInfo: { hasNextPage: false }, nodes: repos } } } });
    if (u.startsWith('/gh/repos/rhys/RSVX-SHOWCASE-SERVER/actions/runs')) {
      return json(res, { workflow_runs: [{ workflow_id: 1, name: 'Sync scripts and deploy', status: 'completed', conclusion: state.workflowConclusion, html_url: 'https://github.com/rhys/x/actions/runs/1', updated_at: iso(5) }] });
    }
    if (u.includes('/actions/runs')) return json(res, { workflow_runs: [] });
    if (u.startsWith('/render/services?')) {
      return json(res, [
        { service: { id: 'srv-1', name: 'ward', type: 'web_service', suspended: 'not_suspended', autoDeploy: 'yes', branch: 'main', rootDir: '', repo: 'https://github.com/rhys/WARD', dashboardUrl: 'https://dashboard.render.com/web/srv-1', updatedAt: iso(100), serviceDetails: { plan: 'free', url: `http://127.0.0.1:${MOCK}/site` } } },
        { service: { id: 'srv-2', name: 'helm-panel', type: 'web_service', suspended: 'not_suspended', autoDeploy: 'yes', branch: 'main', rootDir: '', repo: 'https://github.com/rhys/Fivem', dashboardUrl: 'https://dashboard.render.com/web/srv-2', updatedAt: iso(200), serviceDetails: { plan: 'starter', url: `http://127.0.0.1:${MOCK}/site` } } },
        { service: { id: 'srv-3', name: 'mg11-statement-writer', type: 'static_site', suspended: 'suspended', autoDeploy: 'yes', branch: 'main', repo: 'https://github.com/rhys/mg11', dashboardUrl: 'https://dashboard.render.com/static/srv-3', updatedAt: iso(9000), serviceDetails: { url: 'http://127.0.0.1:1/' } } },
      ]);
    }
    if (u.startsWith('/render/services/srv-1/deploys')) return json(res, [{ deploy: { id: 'd1', status: 'live', commit: { id: repos[0].defaultBranchRef.target.oid }, finishedAt: iso(29) } }]);
    if (u.startsWith('/render/services/srv-2/deploys')) return json(res, [{ deploy: { id: 'd2', status: state.deployStatus, commit: { id: repos[1].defaultBranchRef.target.oid }, finishedAt: iso(100) } }]);
    if (u === '/site') { res.writeHead(state.siteCode); return res.end('hello'); }
    if (u.startsWith('/hook') && req.method === 'POST') {
      const p = JSON.parse(body); state.posts.push(p);
      return json(res, { id: `msg${state.posts.length}` });
    }
    if (u.startsWith('/hook/messages/') && req.method === 'PATCH') { state.patches.push(JSON.parse(body)); return json(res, { id: 'x' }); }
    json(res, { message: 'not found' }, 404);
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(250); }
  throw new Error(`timed out waiting for: ${label}`);
}

(async () => {
  fs.rmSync(path.join(__dirname, '..', 'data'), { recursive: true, force: true });
  await new Promise((r) => mock.listen(MOCK, r));
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: APP, CHECK_INTERVAL: '1', TEST_FAST: '1', STATUS_PASSWORD: 'letmein',
      GITHUB_TOKEN: 't', GITHUB_API: `http://127.0.0.1:${MOCK}/gh`, RENDER_API_KEY: 'k', RENDER_API: `http://127.0.0.1:${MOCK}/render`,
      DISCORD_WEBHOOK_URL: `http://127.0.0.1:${MOCK}/hook`, SITES: `Mock site|http://127.0.0.1:${MOCK}/site`,
      WATCH_PORTS: `Mock server:${MOCK},Dead thing:1`, REPO_ROOTS: process.env.TEST_REPO_ROOTS || '/nonexistent', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    },
    stdio: 'inherit',
  });
  const base = `http://127.0.0.1:${APP}`;
  let failed = false;
  try {
    await until(() => fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false), 'server start');

    // login wall
    let r = await fetch(`${base}/api/status`);
    assert.strictEqual(r.status, 401, 'api needs login');
    r = await fetch(`${base}/login`, { method: 'POST', body: 'password=wrong', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.ok(r.headers.get('location').includes('wrong'), 'wrong password rejected');
    r = await fetch(`${base}/login`, { method: 'POST', body: 'password=letmein', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    assert.ok(cookie.startsWith('rsvx_status='), 'cookie set');
    const status = () => fetch(`${base}/api/status`, { headers: { cookie } }).then((x) => x.json());

    await until(async () => (await status()).ready, 'first cycle');
    await until(() => state.posts.some((p) => p.embeds[0].title.includes('attention') || p.embeds[0].title.includes('running')), 'board posted');
    let s = await status();
    const find = (id) => s.checks.find((c) => c.id === id);
    assert.strictEqual(find('render:srv-2').status, 'ok');
    assert.ok(find('render:srv-1').summary.includes('free plan'), 'free service not pinged');
    assert.strictEqual(find('render:srv-3').status, 'idle', 'suspended service is idle');
    assert.strictEqual(find('gh:rhys/rsvx-showcase-server').kind, 'workflows');
    assert.strictEqual(find('vps:svc:port:Dead thing').status, 'down');
    assert.strictEqual(find('site:127.0.0.1').status, 'ok');
    assert.ok(find('vps:host').bars.length >= 2, 'cpu and ram reported');
    assert.ok(state.posts.some((p) => /existing problem/.test(p.embeds[0].title)), 'startup alert lists existing problem');
    console.log('ok  first cycle, login, startup alert');

    // break a deploy, a workflow and a site
    const before = state.posts.length;
    state.deployStatus = 'build_failed'; state.workflowConclusion = 'failure'; state.siteCode = 503;
    await until(() => state.posts.slice(before).some((p) => p.embeds.some((e) => /failure/.test(e.title))), 'failure alert', 30000);
    const alertText = JSON.stringify(state.posts.slice(before));
    assert.ok(/helm-panel/.test(alertText) && /Deploy failed/.test(alertText), 'deploy failure alerted');
    assert.ok(/Mock site/.test(alertText), 'site failure alerted');
    await until(() => /Sync scripts and deploy/.test(JSON.stringify(state.posts.slice(before))), 'workflow failure alert', 30000);
    s = await status();
    assert.strictEqual(s.overall, 'down');
    assert.ok(s.events.length >= 3, 'events logged');
    console.log('ok  failures alerted');

    // fix everything
    const mid = state.posts.length;
    state.deployStatus = 'live'; state.workflowConclusion = 'success'; state.siteCode = 200;
    await until(() => (JSON.stringify(state.posts.slice(mid)).match(/Recovered/g) || []).length >= 1 && /helm-panel/.test(JSON.stringify(state.posts.slice(mid))), 'recovery alert', 30000);
    console.log('ok  recovery alerted');

    assert.ok(state.patches.length > 3, 'board edited in place');
    const boardPosts = state.posts.filter((p) => p.embeds.some((e) => e.title === 'Render'));
    assert.strictEqual(boardPosts.length, 1, 'only one board message ever posted');
    const lastBoard = state.patches[state.patches.length - 1];
    for (const e of lastBoard.embeds) {
      assert.ok((e.description || '').length <= 4096);
      for (const f of e.fields || []) assert.ok(f.value.length <= 1024 && f.value.length > 0, `field ${f.name} length`);
    }
    assert.ok(JSON.stringify(lastBoard.embeds).length < 6000, 'board under Discord size limit');
    fs.writeFileSync(path.join(__dirname, 'last-board.json'), JSON.stringify(lastBoard, null, 2));
    console.log('ok  board message edited, within Discord limits');
    if (process.env.KEEP) { console.log(`KEEP set: ${base} cookie ${cookie}`); await wait(Number(process.env.KEEP) * 1000); }
  } catch (e) {
    failed = true;
    console.error('FAIL', e);
  } finally {
    app.kill();
    mock.close();
    process.exit(failed ? 1 : 0);
  }
})();
