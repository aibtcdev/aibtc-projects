// Returns mention details for a specific item by scanning the message archive.
// This is more reliable than the events feed because:
// - The archive persists all messages (up to 2000)
// - Matching is done live using current match terms
// - No dependency on event recording completing

import { jsonResponse, corsHeaders } from './_auth.js';
import { getData, matchMention } from './_tasks.js';

const MESSAGE_ARCHIVE_KEY = 'roadmap:message-archive';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const itemId = url.searchParams.get('itemId');
  if (!itemId) {
    return jsonResponse({ error: 'itemId is required' }, 400, corsHeaders());
  }

  const data = await getData(context.env);
  const item = data.items.find(i => i.id === itemId);
  if (!item) {
    return jsonResponse({ error: 'Item not found' }, 404, corsHeaders());
  }

  // Load message archive
  const raw = await context.env.ROADMAP_KV.get(MESSAGE_ARCHIVE_KEY, 'json');
  const messages = raw?.messages || [];

  // Also fetch live activity to catch any messages not yet archived
  let liveMessages = [];
  try {
    const res = await fetch('https://aibtc.com/api/activity', {
      headers: { 'User-Agent': 'aibtc-projects/1.0' },
    });
    if (res.ok) {
      const body = await res.json();
      liveMessages = (body.events || []).filter(e => e.type === 'message' && e.messagePreview);
    }
  } catch (err) {
    console.error('[mentions] live activity fetch failed', err);
  }

  // Merge live + archive, dedup by timestamp
  const seen = new Set();
  const allMessages = [];
  for (const msg of [...liveMessages, ...messages]) {
    if (!msg.timestamp || seen.has(msg.timestamp)) continue;
    seen.add(msg.timestamp);
    allMessages.push(msg);
  }

  // Find all messages that mention this item
  const mentions = [];
  for (const msg of allMessages) {
    const preview = (msg.messagePreview || '').toLowerCase();
    const matchType = matchMention(preview, item);
    if (matchType) {
      mentions.push({
        agent: msg.agent || null,
        recipient: msg.recipient || null,
        messagePreview: msg.messagePreview,
        matchType,
        timestamp: msg.timestamp,
      });
    }
  }

  // Sort newest first
  mentions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return jsonResponse({
    itemId,
    itemTitle: item.title,
    count: item.mentions?.count || 0,
    mentions,
  }, 200, corsHeaders());
}
