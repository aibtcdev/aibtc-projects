import { jsonResponse, corsHeaders } from './_auth.js';

const EVENTS_KEY = 'roadmap:events';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// GET /api/feed — public, returns events with optional filters
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const typeFilter = url.searchParams.get('type') || null;
  const itemIdFilter = url.searchParams.get('itemId') || null;

  const raw = await context.env.ROADMAP_KV.get(EVENTS_KEY, 'json');
  const store = raw || { version: 1, events: [] };

  let events = store.events;

  if (typeFilter) {
    events = events.filter(e => e.type === typeFilter);
  }
  if (itemIdFilter) {
    events = events.filter(e => e.itemId === itemIdFilter);
  }

  events = events.slice(0, limit);

  return jsonResponse({ events, total: events.length }, 200, corsHeaders());
}
