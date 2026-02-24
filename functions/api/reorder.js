import { getAgent, jsonResponse, corsHeaders, recordEvent } from './_auth.js';

const KV_KEY = 'roadmap:items';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost(context) {
  const agent = await getAgent(context.request, context.env);
  if (!agent) {
    return jsonResponse({ error: 'Not authenticated. Use header: Authorization: AIBTC {btcAddress}' }, 401, corsHeaders());
  }

  let body;
  try { body = await context.request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON in request body' }, 400, corsHeaders());
  }
  if (!Array.isArray(body.orderedIds)) {
    return jsonResponse({ error: 'orderedIds array is required' }, 400, corsHeaders());
  }

  const raw = await context.env.ROADMAP_KV.get(KV_KEY, 'json');
  const data = raw || { version: 1, items: [] };

  const map = new Map(data.items.map(i => [i.id, i]));
  const reordered = [];
  for (const id of body.orderedIds) {
    if (map.has(id)) {
      reordered.push(map.get(id));
      map.delete(id);
    }
  }
  for (const item of map.values()) {
    reordered.push(item);
  }

  data.items = reordered;
  data.updatedAt = new Date().toISOString();
  await context.env.ROADMAP_KV.put(KV_KEY, JSON.stringify(data));

  context.waitUntil(recordEvent(context.env, {
    type: 'item.reordered',
    agent,
    itemId: null,
    itemTitle: null,
    data: { count: reordered.length },
  }));

  return jsonResponse({ ok: true, count: reordered.length }, 200, corsHeaders());
}
