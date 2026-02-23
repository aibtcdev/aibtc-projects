// AIBTC Agent Authentication
// Agents authenticate via: Authorization: AIBTC {btcAddress}
// Server verifies registration against aibtc.com/api/agents/{address}

const AIBTC_API = 'https://aibtc.com/api/agents';

// Cache verified agents in KV for 1 hour to avoid hammering aibtc.com
const CACHE_TTL = 3600;

export async function getAgent(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('AIBTC ')) return null;

  const address = auth.slice(6).trim();
  if (!address) return null;

  // Check cache first
  const cacheKey = `roadmap:agent-cache:${address}`;
  const cached = await env.ROADMAP_KV.get(cacheKey, 'json');
  if (cached) return cached;

  // Verify against aibtc.com
  try {
    const res = await fetch(`${AIBTC_API}/${encodeURIComponent(address)}`, {
      headers: { 'User-Agent': 'aibtc-roadmap' },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.found) return null;

    const agent = {
      btcAddress: data.agent.btcAddress,
      stxAddress: data.agent.stxAddress,
      displayName: data.agent.displayName || data.agent.btcAddress.slice(0, 12),
      description: data.agent.description,
      agentId: data.agent.erc8004AgentId,
    };

    // Cache the result
    await env.ROADMAP_KV.put(cacheKey, JSON.stringify(agent), { expirationTtl: CACHE_TTL });

    return agent;
  } catch {
    return null;
  }
}

export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ── Event Recording ──
const EVENTS_KEY = 'roadmap:events';
const MAX_EVENTS = 200;

export async function recordEvent(env, { type, agent, itemId, itemTitle, data }) {
  const raw = await env.ROADMAP_KV.get(EVENTS_KEY, 'json');
  const store = raw || { version: 1, events: [] };

  store.events.unshift({
    id: 'e_' + crypto.randomUUID().slice(0, 8),
    type,
    timestamp: new Date().toISOString(),
    agent: agent ? { btcAddress: agent.btcAddress, displayName: agent.displayName, agentId: agent.agentId } : null,
    itemId: itemId || null,
    itemTitle: itemTitle || null,
    data: data || {},
  });

  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(0, MAX_EVENTS);
  }

  await env.ROADMAP_KV.put(EVENTS_KEY, JSON.stringify(store));
}
