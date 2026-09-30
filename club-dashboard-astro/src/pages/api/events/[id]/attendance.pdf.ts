import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';
import { buildAttendancePdf, meetingDateKey, type AttendanceSheetRow } from '../../../../lib/attendance-pdf';

/**
 * GET /api/events/[id]/attendance.pdf — officers only. The meeting's
 * attendance sheet as a downloadable PDF, named for the meeting's (Pacific)
 * date: "MBC Attendance 2026-10-01.pdf".
 *
 * It carries names AND school emails of everyone who checked in, which is
 * exactly why it is officer-gated (members only ever see their own rows) and
 * no-store (a PDF of emails must never sit in a shared cache). Works for any
 * event status, cancelled included — the sheet says so on its face.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Supabase embeds come back as object or single-element array depending on the FK metadata. */
function one<T>(value: T | T[] | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export const GET: APIRoute = async ({ params, request }) => {
  const responseHeaders = new Headers();
  responseHeaders.set('cache-control', 'no-store');

  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    return apiJson(400, { error: 'Invalid event id' }, responseHeaders);
  }

  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .select('title, start_time, end_time, location, status')
    .eq('id', id)
    .maybeSingle();
  if (eventError) {
    console.error('[api/events/[id]/attendance.pdf] event lookup failed', {
      eventId: id,
      message: eventError.message,
      code: eventError.code,
    });
    return apiJson(500, { error: 'Could not load that meeting' }, responseHeaders);
  }
  if (!event) return apiJson(404, { error: 'Meeting not found' }, responseHeaders);

  const { data: attendance, error: attendanceError } = await supabaseAdmin
    .from('attendance')
    .select('checked_in_at, profiles:member_id ( name, email )')
    .eq('event_id', id)
    .order('checked_in_at', { ascending: true });
  if (attendanceError) {
    console.error('[api/events/[id]/attendance.pdf] attendance read failed', {
      eventId: id,
      message: attendanceError.message,
      code: attendanceError.code,
    });
    return apiJson(500, { error: 'Could not load the attendance' }, responseHeaders);
  }

  const rows: AttendanceSheetRow[] = (attendance ?? []).map((a: any) => {
    const p = one(a.profiles) as { name: string | null; email: string | null } | null;
    return { name: p?.name ?? null, email: p?.email ?? '—', checked_in_at: a.checked_in_at as string };
  });

  let bytes: Uint8Array;
  try {
    bytes = await buildAttendancePdf(event, rows, new Date());
  } catch (err) {
    console.error('[api/events/[id]/attendance.pdf] render failed', {
      eventId: id,
      message: (err as Error)?.message,
    });
    return apiJson(500, { error: 'Could not build the PDF' }, responseHeaders);
  }

  console.info('[api/events/[id]/attendance.pdf] downloaded', {
    eventId: id,
    actorId: guard.session.id,
    rows: rows.length,
  });

  // The filename is built only from the date key (digits and hyphens), so it
  // needs no escaping inside the quoted header parameter.
  const filename = `MBC Attendance ${meetingDateKey(event.start_time)}.pdf`;
  responseHeaders.set('content-type', 'application/pdf');
  responseHeaders.set(
    'content-disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  // The Headers object itself (not a forEach copy) keeps any refreshed session
  // Set-Cookie values intact — same as the 303 in api/preview.ts.
  return new Response(new Uint8Array(bytes), { status: 200, headers: responseHeaders });
};
