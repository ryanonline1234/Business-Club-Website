import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';

/**
 * PATCH /api/events/[id]/recap — officers only.
 * Body: { recap: string }  — plain text, ≤ 8000 characters; '' clears it.
 *
 * Recaps are HISTORY, not previews: only an event whose start_time is already
 * in the past may carry one (400 otherwise). They render on the public /about
 * page in the What We've Done section, server-side and Astro-escaped, split on
 * newlines into paragraphs — so the value stays plain text here.
 *
 * DEPLOY-ORDER FAIL-SOFT: events.recap is added by STEP 17 of
 * supabase-schema.sql, which the owner applies BY HAND and possibly after this
 * code deploys. A missing column is therefore an expected state, not a
 * programming error — it comes back as fixed copy telling the officer what to
 * run, with the real Postgres error only in the server log.
 */

const MAX_RECAP = 8000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "events.recap does not exist": Postgres undefined_column, or the schema
 *  cache miss PostgREST reports instead when it never saw the column. */
const COLUMN_MISSING_CODES = new Set(['42703', 'PGRST204']);

export const PATCH: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    return apiJson(400, { error: 'Invalid event id' }, responseHeaders);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const rawRecap = (body as { recap?: unknown } | null)?.recap;
  if (typeof rawRecap !== 'string') {
    return apiJson(400, { error: 'recap must be a string' }, responseHeaders);
  }
  // Trim the ends only — interior newlines are the paragraph breaks the /about
  // page renders. Empty after trimming means "clear the recap".
  const trimmed = rawRecap.trim();
  if (trimmed.length > MAX_RECAP) {
    return apiJson(
      400,
      { error: `recap must be ${MAX_RECAP} characters or fewer` },
      responseHeaders
    );
  }
  const recap: string | null = trimmed === '' ? null : trimmed;

  // Read the event first: a genuine 404 for an unknown id, and start_time for
  // the past-only rule (a bare .update() matching zero rows reports success).
  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .select('id, start_time')
    .eq('id', id)
    .maybeSingle();

  if (eventError) {
    console.error('[api/events/:id/recap] event lookup failed', {
      eventId: id,
      actorId: session.id,
      code: eventError.code,
      message: eventError.message,
    });
    return apiJson(500, { error: 'Could not load that event' }, responseHeaders);
  }
  if (!event) {
    return apiJson(404, { error: 'Event not found' }, responseHeaders);
  }

  // Recaps are history, not previews. `startMs < now` is the one accepted
  // state; an unparseable start_time (cannot happen for a NOT NULL timestamptz,
  // but NaN comparisons are silently false) falls into the rejection too.
  const startMs = Date.parse(event.start_time as string);
  if (!(startMs < Date.now())) {
    return apiJson(
      400,
      { error: 'Recaps are for events that have already happened' },
      responseHeaders
    );
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .update({ recap })
    .eq('id', id)
    .select('id, title, start_time, recap')
    .single();

  if (error) {
    console.error('[api/events/:id/recap] recap update failed', {
      eventId: id,
      actorId: session.id,
      code: error.code,
      message: error.message,
    });
    if (COLUMN_MISSING_CODES.has(error.code)) {
      return apiJson(
        500,
        { error: 'The recap feature needs a database update — run STEPs 16-18' },
        responseHeaders
      );
    }
    return apiJson(500, { error: 'Could not save the recap' }, responseHeaders);
  }

  return apiJson(200, { data }, responseHeaders);
};
