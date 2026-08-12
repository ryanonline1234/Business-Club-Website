import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';

/**
 * PATCH /api/profile/bio — the caller edits THEIR OWN bio, nothing else.
 * Body: { bio: string }  — plain text, ≤ 1200 characters; '' clears it.
 *
 * The target row is ALWAYS the session user's: the id comes from the guard,
 * never from the request body or URL, so this endpoint cannot be pointed at
 * anyone else's profile.
 *
 * Guarded by apiRequireOfficer, not apiRequireApproved, ON PURPOSE: only
 * officers appear in the /about page's About Us section, so only officers have
 * a bio anywhere to render. DELIBERATE consequence: an officer using the
 * "view as student" preview gets the preview 403 here, because the guard reads
 * the EFFECTIVE role. That is correct behavior, not a bug — the preview's
 * promise is a faithful downgrade to exactly what a member can do, and a
 * member cannot edit an /about bio. Exit the preview to edit yours.
 *
 * Writes ONLY the bio column. Never role or status — see invariant 4 in
 * AGENTS.md; this endpoint must never become a second place profiles rows get
 * their privileges rewritten.
 *
 * DEPLOY-ORDER FAIL-SOFT: profiles.bio is added by STEP 16 of
 * supabase-schema.sql, applied by hand and possibly after this code deploys.
 * A missing column comes back as fixed copy naming the fix, with the real
 * Postgres error only in the server log.
 */

const MAX_BIO = 1200;

/** "profiles.bio does not exist": Postgres undefined_column, or the schema
 *  cache miss PostgREST reports instead when it never saw the column. */
const COLUMN_MISSING_CODES = new Set(['42703', 'PGRST204']);

export const PATCH: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const rawBio = (body as { bio?: unknown } | null)?.bio;
  if (typeof rawBio !== 'string') {
    return apiJson(400, { error: 'bio must be a string' }, responseHeaders);
  }
  // Trim the ends only — interior newlines are the paragraph breaks the /about
  // page renders. Empty after trimming means "clear the bio".
  const trimmed = rawBio.trim();
  if (trimmed.length > MAX_BIO) {
    return apiJson(400, { error: `bio must be ${MAX_BIO} characters or fewer` }, responseHeaders);
  }
  const bio: string | null = trimmed === '' ? null : trimmed;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ bio })
    .eq('id', session.id)
    .select('id, name, bio')
    .single();

  if (error) {
    console.error('[api/profile/bio] bio update failed', {
      actorId: session.id,
      code: error.code,
      message: error.message,
    });
    if (COLUMN_MISSING_CODES.has(error.code)) {
      return apiJson(
        500,
        { error: 'The bio feature needs a database update — run STEPs 16-18' },
        responseHeaders
      );
    }
    return apiJson(500, { error: 'Could not save your bio' }, responseHeaders);
  }

  return apiJson(200, { data }, responseHeaders);
};
