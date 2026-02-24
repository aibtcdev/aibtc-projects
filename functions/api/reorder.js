import { getAgent, jsonResponse, corsHeaders, recordEvent } from './_auth.js';
import { getData, saveData, ConcurrencyError } from './_tasks.js';

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

  const data = await getData(context.env);

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
  try {
    await saveData(context.env, data);
  } catch (err) {
    if (err.name === 'ConcurrencyError') {
      return jsonResponse({ error: 'Another update was in progress. Please retry.' }, 409, corsHeaders());
    }
    throw err;
  }

  context.waitUntil(recordEvent(context.env, {
    type: 'item.reordered',
    agent,
    itemId: null,
    itemTitle: null,
    data: { count: reordered.length },
  }));

  return jsonResponse({ ok: true, count: reordered.length }, 200, corsHeaders());
}
