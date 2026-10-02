import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';
import { parseEventFields } from '../../../../lib/event-input';
import { pacificDayKey } from '../../../../lib/event-time';

/**
 * PATCH /api/events/[id] — officers only. Edit an existing event in place.
 *
 * Before this, the only way to fix a typo or move a meeting was cancel +
 * recreate, which orphaned any check-ins on the old row. Editing keeps the
 * row's id, so attendance, recap and photos stay attached.
 *
 * A PARTIAL update: only the keys present in the body change. Accepted keys
 * are the event fields of POST /api/events/create plus `slides_url`
 * (lib/event-input; the link is validated by lib/slides-link);
 * status, created_by, recap and password are not settable here — an unknown
 * key is ignored. `end_time: null` (or '') clears the end: the meeting then
 * ends at the end of its Pacific day (lib/event-time).
 *
 * Cancelled events are refused (409): they are hidden everywhere, and
 * un-cancelling is deliberately not a feature (table editor only).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PATCH: APIRoute = async ({ params, request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    return apiJson(400, { error: 'Invalid event id' }, responseHeaders);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const parsed = parseEventFields(body, 'update');
  if (!parsed.ok) return apiJson(400, { error: parsed.error }, responseHeaders);
  const fields = parsed.fields;
  if (Object.keys(fields).length === 0) {
    return apiJson(400, { error: 'Nothing to change' }, responseHeaders);
  }

  const { data: current, error: readError } = await supabaseAdmin
    .from('events')
    .select('id, start_time, end_time, status')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    console.error('[api/events/[id] PATCH] read failed', { eventId: id, message: readError.message });
    return apiJson(500, { error: 'Could not load the event' }, responseHeaders);
  }
  if (!current) return apiJson(404, { error: 'Event not found' }, responseHeaders);
  if (current.status === 'cancelled') {
    return apiJson(409, { error: 'This event was cancelled and can’t be edited.' }, responseHeaders);
  }

  // Recaps and photos are history-only (checked when they are written). A
  // meeting that started more than 12 h ago is history: moving it into the
  // future would hide its recap/photos from /about and file its check-ins
  // under a new date. Within 12 h it's still "today's meeting running late",
  // and postponing it stays allowed.
  const HISTORY_AFTER_MS = 12 * 60 * 60 * 1000;
  const nowMs = Date.now();
  if (
    fields.start_time &&
    Date.parse(current.start_time as string) < nowMs - HISTORY_AFTER_MS &&
    Date.parse(fields.start_time) > nowMs
  ) {
    return apiJson(
      409,
      { error: 'This meeting already happened, so it can’t be moved to a future date. Create a new event instead.' },
      responseHeaders
    );
  }

  // Ordering is checked on the MERGED event: moving only the start must not
  // leave the stored end before it.
  const start = fields.start_time ?? (current.start_time as string);
  const end = 'end_time' in fields ? fields.end_time : (current.end_time as string | null);
  if (end && Date.parse(end) <= Date.parse(start)) {
    return apiJson(400, { error: 'end_time must be after start_time' }, responseHeaders);
  }
  // Moving only the start must not stretch the stored end across days
  // (meetings end the day of). The form always sends both when a time changes.
  if ('start_time' in fields && !('end_time' in fields) && end && pacificDayKey(end) !== pacificDayKey(start)) {
    return apiJson(
      400,
      { error: 'The stored end is on a different day than the new start. Send end_time too (null = ends at midnight).' },
      responseHeaders
    );
  }

  const { data, error } = await supabaseAdmin
    .from('events')
    .update(fields)
    .eq('id', id)
    .select('id, title, description, start_time, end_time, location, category, capacity, status')
    .single();
  if (error) {
    console.error('[api/events/[id] PATCH] update failed', { eventId: id, message: error.message, code: error.code });
    // 42703/PGRST204 = events.slides_url not added yet: name the fix.
    if ('slides_url' in fields && (error.code === '42703' || error.code === 'PGRST204')) {
      return apiJson(
        500,
        { error: 'Slides links need a database update — run STEP 20 of supabase-schema.sql.' },
        responseHeaders
      );
    }
    return apiJson(500, { error: 'Could not save the event' }, responseHeaders);
  }

  console.info('[api/events/[id] PATCH] edited', {
    eventId: id,
    actorId: guard.session.id,
    fields: Object.keys(fields),
  });
  return apiJson(200, { data }, responseHeaders);
};
