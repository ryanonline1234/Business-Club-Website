import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { verifyQRToken } from '../../../lib/qrcode';
import { apiJson, apiRequireApproved } from '../../../lib/auth';

/**
 * POST /api/attendance/checkin — record the CALLER's attendance.
 *
 * SECURITY CONTRACT — read before editing.
 *   The request body carries `qr_token` and NOTHING ELSE. The member whose
 *   attendance is written is always `session.id`, resolved server-side from the
 *   session cookie. This endpoint previously accepted `member_id` from the body
 *   and only consulted the session as a fallback, which meant anyone holding a
 *   projected QR token could write attendance for any member — member UUIDs are
 *   not secret. Never reintroduce a client-supplied member identity here.
 *
 * Three independent things are checked before the insert:
 *   1. the caller is signed in AND approved            (apiRequireApproved)
 *   2. the token is a valid, unexpired, correctly-signed check-in token
 *   3. the event it names exists, is 'active', and is inside its check-in window
 *
 * (2) alone is not enough: a token stays valid for its full lifetime even if the
 * event is cancelled a minute after it was projected.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The check-in window.
 *
 *   opens  = start_time - 30 minutes
 *   closes = end_time + 2 hours, or start_time + 4 hours when end_time is null
 *
 * These constants are duplicated in src/pages/api/events/[id]/qr.ts, which
 * refuses to mint a token for an event whose window has already closed. Keep
 * the two in sync; they cannot live in a shared module without editing
 * src/lib/**, which this change is not allowed to touch.
 * ──────────────────────────────────────────────────────────────────────────── */
const OPENS_BEFORE_START_MS = 30 * 60 * 1000;
const CLOSES_AFTER_END_MS = 2 * 60 * 60 * 1000;
const ASSUMED_LENGTH_MS = 4 * 60 * 60 * 1000;

/** Postgres unique_violation — the attendance_event_member_unique backstop. */
const PG_UNIQUE_VIOLATION = '23505';

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Null when start_time is missing or unparseable — the caller treats that as a
 * server-side data problem rather than silently letting the check-in through.
 * An end_time at or before start_time is treated as absent: that is bad data,
 * and falling back to the 4-hour rule beats computing a window that closed
 * before it opened and locking everyone out of a real meeting.
 */
function checkinWindow(
  startTime: unknown,
  endTime: unknown
): { opensAt: number; closesAt: number } | null {
  const start = parseTime(startTime);
  if (start === null) return null;

  const end = parseTime(endTime);
  const closesAt =
    end === null || end <= start ? start + ASSUMED_LENGTH_MS : end + CLOSES_AFTER_END_MS;

  return { opensAt: start - OPENS_BEFORE_START_MS, closesAt };
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireApproved(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const body: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  // Tripwire, not validation. member_id is no longer part of the contract; if
  // something is still sending one, it is either stale client code or a probe.
  if (body.member_id !== undefined) {
    console.warn('[attendance/checkin] ignoring member_id in request body', {
      callerId: session.id,
    });
  }

  const qrToken = body.qr_token;
  if (typeof qrToken !== 'string' || qrToken.trim() === '') {
    return apiJson(400, { error: 'Missing qr_token' }, responseHeaders);
  }

  const payload = await verifyQRToken(qrToken);
  if (!payload) {
    return apiJson(
      400,
      { error: "This QR code has expired or isn't valid. Ask an officer to show a fresh one." },
      responseHeaders
    );
  }

  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .select('id, title, start_time, end_time, status')
    .eq('id', payload.event_id)
    .maybeSingle();

  if (eventError) {
    console.error('[attendance/checkin] event lookup failed', {
      eventId: payload.event_id,
      jti: payload.jti,
      message: eventError.message,
      code: eventError.code,
    });
    return apiJson(500, { error: 'Could not load the event. Try again.' }, responseHeaders);
  }

  if (!event) {
    // A validly-signed token for an event that no longer exists.
    console.warn('[attendance/checkin] token references a missing event', {
      eventId: payload.event_id,
      jti: payload.jti,
    });
    return apiJson(404, { error: 'Event not found' }, responseHeaders);
  }

  if (event.status !== 'active') {
    return apiJson(
      403,
      {
        error: 'This event is no longer accepting check-ins.',
        reason: 'event_not_active',
      },
      responseHeaders
    );
  }

  const openFor = checkinWindow(event.start_time, event.end_time);
  if (!openFor) {
    console.error('[attendance/checkin] event has an unparseable start_time', {
      eventId: event.id,
      startTime: event.start_time,
    });
    return apiJson(500, { error: 'Could not load the event. Try again.' }, responseHeaders);
  }

  const now = Date.now();
  if (now < openFor.opensAt) {
    return apiJson(
      403,
      {
        error: "Check-in isn't open yet for this event.",
        reason: 'checkin_not_open',
        opens_at: new Date(openFor.opensAt).toISOString(),
      },
      responseHeaders
    );
  }
  if (now > openFor.closesAt) {
    return apiJson(
      403,
      {
        error: 'Check-in for this event has closed.',
        reason: 'checkin_closed',
        closed_at: new Date(openFor.closesAt).toISOString(),
      },
      responseHeaders
    );
  }

  // Explicit duplicate lookup so the common case returns a clean 409 instead of
  // relying on the constraint violation. The constraint is still the backstop
  // for two requests racing — see the insert error handling below.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('attendance')
    .select('id, checked_in_at')
    .eq('event_id', event.id)
    .eq('member_id', session.id)
    .maybeSingle();

  if (existingError) {
    console.error('[attendance/checkin] duplicate lookup failed', {
      eventId: event.id,
      memberId: session.id,
      message: existingError.message,
      code: existingError.code,
    });
    return apiJson(500, { error: 'Could not record the check-in. Try again.' }, responseHeaders);
  }

  if (existing) {
    return apiJson(
      409,
      { error: 'Already checked in', checked_in_at: existing.checked_in_at },
      responseHeaders
    );
  }

  const { data: record, error: insertError } = await supabaseAdmin
    .from('attendance')
    .insert({
      event_id: event.id,
      member_id: session.id, // session ONLY — never a client-supplied id
      method: 'qr',
    })
    .select('id, checked_in_at')
    .single();

  if (insertError) {
    // attendance_event_member_unique caught a race the lookup above missed.
    if (insertError.code === PG_UNIQUE_VIOLATION) {
      return apiJson(409, { error: 'Already checked in' }, responseHeaders);
    }
    // Never echo the raw Postgres message to the client.
    console.error('[attendance/checkin] insert failed', {
      eventId: event.id,
      memberId: session.id,
      message: insertError.message,
      code: insertError.code,
    });
    return apiJson(500, { error: 'Could not record the check-in. Try again.' }, responseHeaders);
  }

  console.info('[attendance/checkin] recorded', {
    eventId: event.id,
    memberId: session.id,
    jti: payload.jti,
  });

  return apiJson(
    201,
    {
      success: true,
      // From the session's own profile row, not from a join on the inserted row.
      member_name: session.name ?? session.email.split('@')[0] ?? 'Member',
      checked_in_at: record.checked_in_at,
      event: { id: event.id, title: event.title },
    },
    responseHeaders
  );
};
