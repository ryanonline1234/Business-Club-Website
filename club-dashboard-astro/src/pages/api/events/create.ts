import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';
import { parseEventFields } from '../../../lib/event-input';

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

  // Field rules live in lib/event-input, shared with PATCH /api/events/:id.
  const parsed = parseEventFields(body, 'create');
  if (!parsed.ok) return apiJson(400, { error: parsed.error }, responseHeaders);
  const { title, start_time: startTime, end_time: endTime, description, location, category, capacity } =
    parsed.fields;

  // No end_time = the meeting ends at the end of its Pacific day
  // (lib/event-time). An explicit one must come after the start.
  if (endTime && Date.parse(endTime) <= Date.parse(startTime as string)) {
    return apiJson(400, { error: 'end_time must be after start_time' }, responseHeaders);
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
