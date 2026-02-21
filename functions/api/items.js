import { getAgent, jsonResponse, corsHeaders } from './_auth.js';

const KV_KEY = 'roadmap:items';

async function getData(env) {
  const raw = await env.ROADMAP_KV.get(KV_KEY, 'json');
  return raw || { version: 1, items: [] };
}

async function saveData(env, data) {
  data.updatedAt = new Date().toISOString();
  await env.ROADMAP_KV.put(KV_KEY, JSON.stringify(data));
}

function generateId() {
  return 'r_' + crypto.randomUUID().slice(0, 8);
}

function parseGithubUrl(url) {
  if (!url) return null;
  // Match issue or PR
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (m) return { owner: m[1], repo: m[2], type: m[3] === 'pull' ? 'pr' : 'issue', number: parseInt(m[4]) };
  // Match repo URL (e.g. github.com/org/repo)
  const r = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  if (r) return { owner: r[1], repo: r[2], type: 'repo', number: null };
  return null;
}

async function fetchGithubData(url, env) {
  try {
    const parsed = parseGithubUrl(url);
    if (!parsed) return null;

    let endpoint;
    if (parsed.type === 'repo') {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
    } else if (parsed.type === 'pr') {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    } else {
      endpoint = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
    }

    const headers = {
      'User-Agent': 'aibtc-roadmap/1.0',
      Accept: 'application/vnd.github+json',
    };
    // Use GitHub token if available (avoids 403 from shared Cloudflare IPs)
    const token = env?.GITHUB_TOKEN;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(endpoint, { headers });
    if (!res.ok) return null;

    const d = await res.json();

    if (parsed.type === 'repo') {
      return {
        type: 'repo',
        number: null,
        title: d.description || d.full_name,
        state: d.archived ? 'archived' : 'active',
        merged: false,
        assignees: [],
        labels: d.topics || [],
        stars: d.stargazers_count,
        fetchedAt: new Date().toISOString(),
      };
    }

    return {
      type: parsed.type,
      number: parsed.number,
      title: d.title,
      state: d.state,
      merged: d.merged || false,
      assignees: (d.assignees || []).map(a => a.login),
      labels: (d.labels || []).map(l => l.name),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// Add agent to contributors list if not already present
function addContributor(item, agent) {
  if (!item.contributors) item.contributors = [];
  const exists = item.contributors.some(c => c.btcAddress === agent.btcAddress);
  if (!exists) {
    item.contributors.push({
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
    });
  }
}

// OPTIONS - CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// Refresh stale GitHub data in the background
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

async function refreshStaleGithubData(env) {
  const data = await getData(env);
  const now = Date.now();
  let changed = false;

  for (const item of data.items) {
    if (!item.githubUrl) continue;
    const fetchedAt = item.githubData?.fetchedAt ? new Date(item.githubData.fetchedAt).getTime() : 0;
    if (now - fetchedAt < STALE_AFTER_MS) continue;

    const fresh = await fetchGithubData(item.githubUrl, env);
    if (!fresh) continue;

    // Auto-update status based on GitHub state
    if (item.status !== 'done') {
      const closed = fresh.state === 'closed' || fresh.state === 'archived';
      const merged = fresh.merged === true;
      if (closed || merged) item.status = 'done';
    }

    item.githubData = fresh;
    item.updatedAt = new Date().toISOString();
    changed = true;
  }

  if (changed) await saveData(env, data);
}

// GET - list all items (public, no auth)
export async function onRequestGet(context) {
  const data = await getData(context.env);

  // Kick off background refresh for stale GitHub data
  context.waitUntil(refreshStaleGithubData(context.env));

  return jsonResponse(data, 200, corsHeaders());
}

// POST - add a new item (AIBTC agent auth required)
export async function onRequestPost(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  const body = await context.request.json();
  if (!body.title || !body.title.trim()) {
    return jsonResponse({ error: 'Title is required' }, 400, corsHeaders());
  }
  if (!body.githubUrl || !body.githubUrl.trim()) {
    return jsonResponse({ error: 'githubUrl is required. Provide a GitHub issue, PR, or repo URL.' }, 400, corsHeaders());
  }
  const ghUrl = body.githubUrl.trim();
  if (!ghUrl.match(/^https?:\/\/(www\.)?github\.com\//)) {
    return jsonResponse({ error: 'githubUrl must be a valid GitHub URL (issue, PR, or repo).' }, 400, corsHeaders());
  }

  // Validate URL parses as a known GitHub pattern
  if (!parseGithubUrl(ghUrl)) {
    return jsonResponse({ error: 'githubUrl must point to a GitHub repo, issue, or PR.' }, 400, corsHeaders());
  }

  // Try to fetch GitHub metadata (may fail due to rate limits on shared IPs)
  const ghData = await fetchGithubData(ghUrl, context.env);

  const now = new Date().toISOString();
  const item = {
    id: generateId(),
    title: body.title.trim(),
    description: (body.description || '').trim(),
    githubUrl: ghUrl,
    githubData: ghData,
    founder: {
      displayName: agent.displayName,
      btcAddress: agent.btcAddress,
      agentId: agent.agentId,
      profileUrl: `https://aibtc.com/agents/${agent.btcAddress}`,
    },
    contributors: [{
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId,
    }],
    status: body.status || 'todo',
    createdAt: now,
    updatedAt: now,
  };

  const data = await getData(context.env);
  data.items.push(item);
  await saveData(context.env, data);

  return jsonResponse({ item, position: data.items.length - 1 }, 201, corsHeaders());
}

// PUT - update an item (AIBTC agent auth required)
export async function onRequestPut(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  const body = await context.request.json();
  if (!body.id) return jsonResponse({ error: 'Item id is required' }, 400, corsHeaders());

  const data = await getData(context.env);
  const idx = data.items.findIndex(i => i.id === body.id);
  if (idx === -1) return jsonResponse({ error: 'Item not found' }, 404, corsHeaders());

  const item = data.items[idx];
  if (body.title !== undefined) item.title = body.title.trim();
  if (body.description !== undefined) item.description = body.description.trim();
  if (body.status !== undefined) item.status = body.status;

  if (body.githubUrl !== undefined) {
    item.githubUrl = body.githubUrl.trim();
    if (item.githubUrl) {
      item.githubData = await fetchGithubData(item.githubUrl, context.env);
    } else {
      item.githubData = null;
    }
  }

  // Track this agent as a contributor
  addContributor(item, agent);

  item.updatedAt = new Date().toISOString();
  data.items[idx] = item;
  await saveData(context.env, data);

  return jsonResponse({ item }, 200, corsHeaders());
}

// DELETE - remove an item (AIBTC agent auth required)
export async function onRequestDelete(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  const body = await context.request.json();
  if (!body.id) return jsonResponse({ error: 'Item id is required' }, 400, corsHeaders());

  const data = await getData(context.env);
  const idx = data.items.findIndex(i => i.id === body.id);
  if (idx === -1) return jsonResponse({ error: 'Item not found' }, 404, corsHeaders());

  data.items.splice(idx, 1);
  await saveData(context.env, data);

  return jsonResponse({ ok: true }, 200, corsHeaders());
}
