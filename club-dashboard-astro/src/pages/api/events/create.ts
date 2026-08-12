import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';

/**
 * POST /api/events/create — officers only.
 *
 * The `password` field is deliberately absent. security_fixes #13: it was
 * persisted in plaintext for a password check-in flow that was never built and
 * that nothing ever reads, while the form label told officers it worked. The
 * events.password COLUMN stays in the database (same reversible posture as the
 * finance tables) but this endpoint never reads or writes it — a `password` key
 * in the request body is silently ignored. If password check-in is ever built,
 * hash it.
 */

/** Generous ceilings — a guard against absurd payloads, not a content policy. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_LOCATION = 300;
const MAX_CATEGORY = 60;

/** integer column ceiling in Postgres — larger values would 500 on insert */
const MAX_CAPACITY = 2147483647;

/** Trimmed string, or null for absent / non-string / empty-after-trim. */
function optionalText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const title = optionalText(body.title);
  const startTime = optionalText(body.start_time);

  if (!title || !startTime) {
    return apiJson(400, { error: 'title and start_time are required' }, responseHeaders);
  }
  if (title.length > MAX_TITLE) {
    return apiJson(400, { error: `title must be ${MAX_TITLE} characters or fewer` }, responseHeaders);
  }

  // Validate only — the raw string is what gets inserted, so Postgres keeps
  // doing the timestamptz parsing it already did. Date.parse here is the
  // "is this a date at all" gate and the basis for the ordering check.
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs)) {
    return apiJson(400, { error: 'start_time is not a valid date and time' }, responseHeaders);
  }

  const endTime = optionalText(body.end_time);
  if (endTime !== null) {
    const endMs = Date.parse(endTime);
    if (Number.isNaN(endMs)) {
      return apiJson(400, { error: 'end_time is not a valid date and time' }, responseHeaders);
    }
    if (endMs <= startMs) {
      return apiJson(400, { error: 'end_time must be after start_time' }, responseHeaders);
    }
  }

  const description = optionalText(body.description);
  if (description !== null && description.length > MAX_DESCRIPTION) {
    return apiJson(
      400,
      { error: `description must be ${MAX_DESCRIPTION} characters or fewer` },
      responseHeaders
    );
  }

  const location = optionalText(body.location);
  if (location !== null && location.length > MAX_LOCATION) {
    return apiJson(400, { error: `location must be ${MAX_LOCATION} characters or fewer` }, responseHeaders);
  }

  const category = optionalText(body.category) ?? 'meeting';
  if (category.length > MAX_CATEGORY) {
    return apiJson(400, { error: `category must be ${MAX_CATEGORY} characters or fewer` }, responseHeaders);
  }

  // capacity: absent / null / '' means "no cap". Anything else must be a real
  // positive integer. The old `parseInt(capacity)` turned "abc" into NaN and
  // handed it to the insert.
  const rawCapacity = body.capacity;
  let capacity: number | null = null;
  if (rawCapacity !== undefined && rawCapacity !== null && rawCapacity !== '') {
    const parsed =
      typeof rawCapacity === 'number'
        ? rawCapacity
        : typeof rawCapacity === 'string'
          ? Number(rawCapacity.trim())
          : Number.NaN;
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_CAPACITY) {
      return apiJson(400, { error: 'capacity must be a positive whole number' }, responseHeaders);
    }
    capacity = parsed;
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .insert({
      title,
      description,
      start_time: startTime,
      end_time: endTime,
      location,
      category,
      capacity,
      status: 'active',
      created_by: session.id,
      // NO `password` — see the note at the top of this file.
    })
    .select()
    .single();

  if (error) {
    // Detail stays in the Vercel function log; the client gets a fixed string
    // rather than a Postgres message.
    console.error('[api/events/create]', error);
    return apiJson(500, { error: 'Could not create the event' }, responseHeaders);
  }

  return apiJson(201, { data }, responseHeaders);
};
