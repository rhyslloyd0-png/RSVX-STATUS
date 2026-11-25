'use strict';

// GitHub: every repo you own, its latest commit, and whether the latest
// GitHub Actions runs on the default branch passed (auto-sync, push-deploy etc).

const { fetchJson, pool, ago, short, list } = require('./util');

const api = () => process.env.GITHUB_API || 'https://api.github.com';
const ignore = () => new Set(list(process.env.IGNORE_REPOS).map((s) => s.toLowerCase()));

const QUERY = 'query($c:String){viewer{login repositories(first:100,after:$c,ownerAffiliations:OWNER,orderBy:{field:PUSHED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{name nameWithOwner url isPrivate isArchived pushedAt defaultBranchRef{name target{... on Commit{oid messageHeadline committedDate}}}}}}}';

// "owner/repo" (lowercase) -> { sha, branch, committedAt, url }. Read by the Render and VPS checks.
const heads = new Map();
// "owner/repo" -> { pushedAt, fetchedAt, hotUntil, result }
const runCache = new Map();

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rsvx-status',
    'Content-Type': 'application/json',
  };
}

async function listRepos() {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const body = await fetchJson(`${api()}/graphql`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ query: QUERY, variables: { c: cursor } }),
    });
    if (!body || !body.data || !body.data.viewer) {
      throw new Error(body && body.errors ? body.errors[0].message : 'unexpected reply');
    }
    const r = body.data.viewer.repositories;
    repos.push(...r.nodes.filter(Boolean));
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return repos;
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

async function latestRuns(repo) {
  const branch = repo.defaultBranchRef.name;
  const body = await fetchJson(
    `${api()}/repos/${repo.nameWithOwner}/actions/runs?per_page=15&branch=${encodeURIComponent(branch)}`,
    { headers: headers() },
  );
  const latest = new Map(); // newest run of each workflow
  for (const r of body.workflow_runs || []) {
    if (!latest.has(r.workflow_id)) latest.set(r.workflow_id, r);
  }
  const runs = [...latest.values()];
  return {
    total: runs.length,
    failed: runs.filter((r) => r.status === 'completed' && FAILED.has(r.conclusion)).map((r) => ({ name: r.name, url: r.html_url })),
    running: runs.filter((r) => r.status !== 'completed').map((r) => r.name),
  };
}

function needsRefresh(key, repo, now) {
  const c = runCache.get(key);
  if (!c) return true;
  if (c.pushedAt !== repo.pushedAt) return true;
  if (now < c.hotUntil) return true;                    // just pushed: a run may still be starting
  if (c.result && c.result.total) return true;          // repos that use Actions are read every time
  return now - c.fetchedAt > 15 * 60 * 1000;            // the rest: look again now and then for new workflows
}

async function collect(now = Date.now()) {
  const skip = ignore();
  const repos = (await listRepos()).filter((r) => !r.isArchived && r.defaultBranchRef && r.defaultBranchRef.target && !skip.has(r.name.toLowerCase()));

  heads.clear();
  for (const r of repos) {
    heads.set(r.nameWithOwner.toLowerCase(), {
      sha: r.defaultBranchRef.target.oid,
      branch: r.defaultBranchRef.name,
      committedAt: Date.parse(r.defaultBranchRef.target.committedDate),
      url: r.url,
    });
  }

  const stale = repos.filter((r) => needsRefresh(r.nameWithOwner.toLowerCase(), r, now));
  await pool(stale, 6, async (r) => {
    const key = r.nameWithOwner.toLowerCase();
    const prev = runCache.get(key);
    const pushed = prev && prev.pushedAt !== r.pushedAt;
    let result = prev ? prev.result : null;
    let error = null;
    try { result = await latestRuns(r); } catch (e) { error = e.message; }
    runCache.set(key, {
      pushedAt: r.pushedAt, fetchedAt: now, result, error,
      hotUntil: pushed ? now + 10 * 60 * 1000 : (prev ? prev.hotUntil : 0),
    });
  });

  return repos.map((r) => {
    const key = r.nameWithOwner.toLowerCase();
    const head = r.defaultBranchRef.target;
    const cache = runCache.get(key) || {};
    const runs = cache.result;
    const pushedAt = Date.parse(r.pushedAt);
    const commit = `${short(head.oid)} ${head.messageHeadline || ''}`.trim();
    let status = 'ok';
    let summary = commit;
    let url = r.url;

    if (runs && runs.failed.length) {
      status = 'down';
      summary = `Workflow failed: ${runs.failed.map((f) => f.name).join(', ')}`;
      url = runs.failed[0].url;
    } else if (runs && runs.running.length) {
      status = 'pending';
      summary = `Workflow running: ${runs.running.join(', ')}`;
    } else if (runs && runs.total) {
      summary = `Workflows passing · ${commit}`;
    }

    return {
      id: `gh:${key}`, group: 'github', name: r.name, status, summary, url,
      meta: `pushed ${ago(now - pushedAt)} ago`,
      sort: pushedAt,
      recent: now - pushedAt < 7 * 24 * 3600 * 1000,
      kind: runs && runs.total ? 'workflows' : 'plain',
    };
  });
}

module.exports = { collect, heads, enabled: () => !!process.env.GITHUB_TOKEN, missing: 'Add GITHUB_TOKEN to .env' };
