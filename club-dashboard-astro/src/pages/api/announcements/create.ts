import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';

/**
 * POST /api/announcements/create — officers only.
 *
 * author_id and author_name come from the session, never from the client.
 * The stored body is plain text: /announcements must render it with
 * textContent, never innerHTML.
 */

/** Generous ceilings — a guard against absurd payloads, not a content policy. */
const MAX_TITLE = 200;
const MAX_BODY = 20000;

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const bodyText = typeof payload.body === 'string' ? payload.body.trim() : '';

  if (!title || !bodyText) {
    return apiJson(400, { error: 'title and body are required' }, responseHeaders);
  }
  if (title.length > MAX_TITLE) {
    return apiJson(400, { error: `title must be ${MAX_TITLE} characters or fewer` }, responseHeaders);
  }
  if (bodyText.length > MAX_BODY) {
    return apiJson(400, { error: `body must be ${MAX_BODY} characters or fewer` }, responseHeaders);
  }

  const { data, error } = await supabaseAdmin
    .from('announcements')
    .insert({
      title,
      body: bodyText,
      author_id: session.id,
      author_name: session.name,
    })
    .select()
    .single();

  if (error) {
    // Detail stays in the Vercel function log; the client gets a fixed string
    // rather than a Postgres message.
    console.error('[api/announcements/create]', error);
    return apiJson(500, { error: 'Could not post the announcement' }, responseHeaders);
  }

  return apiJson(201, { data }, responseHeaders);
};
