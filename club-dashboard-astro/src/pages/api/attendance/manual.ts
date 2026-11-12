import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';
import { checkinWindow } from '../../../lib/event-time';
import { findOrCreateMember, parseEmailList, type ParsedEntry } from '../../../lib/member-invite';

/**
 * POST /api/attendance/manual — officer-only. Check people in to a meeting by
 * email, from /attendance.
 *
 * WHY THIS EXISTS
 *   Not everyone can scan the code: no phone, never signed in, the code had
 *   closed. People write their email on the board or a sheet instead, and an
 *   officer types the list in here after the meeting (owner request,
 *   2026-11-11).
 *
 * WHO GETS WRITTEN
 *   Only the addresses the officer typed, each resolved to a profile by email
 *   on the server — school addresses only, via src/lib/member-invite.ts.
 *   Someone with no account gets one exactly as add-by-email makes it, so
 *   their first Google sign-in lands on the account that already holds this
 *   check-in: the attendance is on their record from the start and on the
 *   meeting's PDF straight away. This is the ONE endpoint that writes
 *   attendance for someone other than the caller, which is why it is
 *   officer-gated. POST /api/attendance/checkin must never gain that ability.
 *
 * WHICH MEETINGS, AND WHEN
 *   Any meeting that is not cancelled, once its check-in has opened
 *   (start − 30 min, the QR endpoint's own rule). No closing time: typing a
 *   sheet in after the meeting is the point.
 *
 * WHAT A ROW RECORDS
 *   method 'manual' and checked_in_by = the officer (STEP 21), so the PDF and
 *   the log can tell it from a scan. A check-in typed in after the QR window
 *   has closed is stamped with the meeting's START time, so a member's history
 *   lists the meeting's day rather than the day it was typed; created_at still
 *   holds the real time.
 */

/** One board or sheet at a time. */
const MAX_ENTRIES = 100;
/** Account creations and inserts at once. Modest: this is a write path. */
const CONCURRENCY = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres unique_violation — attendance_event_member_unique caught a race. */
const PG_UNIQUE_VIOLATION = '23505';
/** check_violation (method 'manual' refused) or undefined_column / PostgREST's
 *  schema-cache miss (checked_in_by unknown): the database predates STEP 21. */
const NEEDS_STEP_21 = new Set(['23514', '42703', 'PGRST204']);

type Outcome = 'checked_in' | 'created' | 'already' | 'rejected';
interface Result {
  email: string;
  outcome: Outcome;
  /** Present on 'rejected'; human-readable and safe to render. */
  reason?: string;
  /** Present on 'created': the name the new account carries until first sign-in. */
  name?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: { event_id?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  if (!UUID_RE.test(eventId)) {
    return apiJson(400, { error: 'Pick a meeting first.' }, responseHeaders);
  }

  const parsed = parseEmailList(body.text, MAX_ENTRIES);
  if (!parsed.ok) return apiJson(400, { error: parsed.error }, responseHeaders);

  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .select('id, title, start_time, end_time, status')
    .eq('id', eventId)
    .maybeSingle();

  if (eventError) {
    console.error('[api/attendance/manual] event lookup failed', {
      eventId,
      code: eventError.code,
      message: eventError.message,
    });
    return apiJson(500, { error: 'Could not load the meeting. Try again.' }, responseHeaders);
  }
  if (!event) return apiJson(404, { error: 'Meeting not found' }, responseHeaders);
  if (event.status === 'cancelled') {
    return apiJson(
      403,
      { error: 'That meeting was cancelled.', reason: 'event_cancelled' },
      responseHeaders
    );
  }

  const win = checkinWindow(event.start_time, event.end_time);
  if (!win) {
    console.error('[api/attendance/manual] event has an unparseable start_time', {
      eventId: event.id,
      startTime: event.start_time,
    });
    return apiJson(500, { error: 'Could not load the meeting. Try again.' }, responseHeaders);
  }
  const now = Date.now();
  if (now < win.opensAt) {
    return apiJson(
      403,
      {
        error: "That meeting hasn't started yet.",
        reason: 'checkin_not_open',
        opens_at: new Date(win.opensAt).toISOString(),
      },
      responseHeaders
    );
  }
  // Inside the QR window: the real time. After it: the meeting's start, so
  // the check-in sits on the meeting's day (see WHAT A ROW RECORDS).
  const checkedInAt = now <= win.closesAt ? new Date(now).toISOString() : (event.start_time as string);

  const results: Result[] = parsed.rejected.map((r) => ({ email: r.email, outcome: 'rejected', reason: r.reason }));
  let needsStep21 = false;

  async function checkIn(entry: ParsedEntry): Promise<Result> {
    const { email } = entry;
    const member = await findOrCreateMember(entry, session.id, 'api/attendance/manual');

    if (member.outcome === 'error') return { email, outcome: 'rejected', reason: member.reason };
    if (member.outcome === 'auth-only') {
      return {
        email,
        outcome: 'rejected',
        reason: 'They have an account that never finished setting up. Ask them to sign in once, then try again.',
      };
    }
    if (member.outcome === 'existing' && member.status === 'rejected') {
      return { email, outcome: 'rejected', reason: 'Their account is suspended on the Members page.' };
    }

    // Explicit duplicate lookup so the common case reads "already checked in";
    // the unique constraint stays the backstop for two officers racing.
    const dup = await supabaseAdmin
      .from('attendance')
      .select('id')
      .eq('event_id', event!.id)
      .eq('member_id', member.id)
      .maybeSingle();
    if (dup.error) {
      console.error('[api/attendance/manual] duplicate lookup failed', {
        eventId: event!.id,
        memberId: member.id,
        code: dup.error.code,
        message: dup.error.message,
      });
      return { email, outcome: 'rejected', reason: 'Could not record the check-in. Try again.' };
    }
    if (dup.data) return { email, outcome: 'already' };

    const insert = await supabaseAdmin.from('attendance').insert({
      event_id: event!.id,
      member_id: member.id,
      method: 'manual',
      checked_in_by: session.id,
      checked_in_at: checkedInAt,
    });

    if (insert.error) {
      if (insert.error.code === PG_UNIQUE_VIOLATION) return { email, outcome: 'already' };
      if (NEEDS_STEP_21.has(insert.error.code)) needsStep21 = true;
      console.error('[api/attendance/manual] insert failed', {
        eventId: event!.id,
        memberId: member.id,
        code: insert.error.code,
        message: insert.error.message,
      });
      return { email, outcome: 'rejected', reason: 'Could not record the check-in. Try again.' };
    }

    return member.outcome === 'created'
      ? { email, outcome: 'created', name: member.name }
      : { email, outcome: 'checked_in' };
  }

  for (let i = 0; i < parsed.entries.length; i += CONCURRENCY) {
    const batch = parsed.entries.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(checkIn))));
  }

  if (needsStep21) {
    return apiJson(
      500,
      { error: 'Manual check-in needs a database update — run STEP 21 of supabase-schema.sql.' },
      responseHeaders
    );
  }

  const summary = {
    checked_in: results.filter((r) => r.outcome === 'checked_in').length,
    created: results.filter((r) => r.outcome === 'created').length,
    already: results.filter((r) => r.outcome === 'already').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
  };

  console.info('[api/attendance/manual] checked in by officer', {
    eventId: event.id,
    actorId: session.id,
    ...summary,
  });

  return apiJson(200, { summary, results, event: { id: event.id, title: event.title } }, responseHeaders);
};
