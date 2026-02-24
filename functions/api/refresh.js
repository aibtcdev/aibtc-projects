// Dedicated endpoint for triggering background refresh tasks.
// Called by GitHub Actions cron every 15 minutes.

import { jsonResponse, corsHeaders } from './_auth.js';
import { refreshStaleGithubData, scanForMentions, backfillMentions, scanGithubContributors, scanGithubEvents } from './_tasks.js';

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const secret = url.searchParams.get('key');
  const expectedKey = context.env.REFRESH_KEY;

  // If REFRESH_KEY is set in env, require it for access
  if (expectedKey && secret !== expectedKey) {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders());
  }

  const start = Date.now();
  const reset = url.searchParams.get('reset') === 'true';

  // GitHub data refresh is read-only on items, safe to run first
  const ghResult = await refreshStaleGithubData(context.env);

  // Run item-mutating scans sequentially to avoid KV write conflicts
  const mentionResult = await scanForMentions(context.env, { reset });
  const contributorResult = await scanGithubContributors(context.env);
  const eventResult = await scanGithubEvents(context.env);

  // Backfill operates on events KV only (not items), safe to run last
  const backfillResult = await backfillMentions(context.env);

  const elapsed = Date.now() - start;

  return jsonResponse({
    ok: true,
    elapsed: `${elapsed}ms`,
    github: ghResult,
    mentions: mentionResult,
    githubContributors: contributorResult,
    githubEvents: eventResult,
    backfill: backfillResult,
    timestamp: new Date().toISOString(),
  }, 200, corsHeaders());
}
