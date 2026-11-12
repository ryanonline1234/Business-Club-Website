import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';

/**
 * DELETE /api/attendance/:id — officer-only. Remove one check-in, from the
 * check-in log on /attendance: a mistyped email, the wrong meeting.
 *
 * Any method, not only 'manual' — officers already manage all attendance
 * (STEP 14's "Officers can manage all attendance"), and a mistaken scan needs
 * fixing as much as a mistaken entry. One row per call; the log names who did
 * it, since audit_logs has no writer.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    // Without this, a non-uuid path segment reaches Postgres and comes back as
    // a 500 "invalid input syntax for type uuid".
    return apiJson(400, { error: 'Invalid check-in id' }, responseHeaders);
  }

  // Delete and read back in one statement, so the log line describes the row
  // that was actually removed.
  const { data, error } = await supabaseAdmin
    .from('attendance')
    .delete()
    .eq('id', id)
    .select('id, event_id, member_id, method');

  if (error) {
    console.error('[api/attendance/:id] delete failed', {
      attendanceId: id,
      actorId: session.id,
      code: error.code,
      message: error.message,
    });
    return apiJson(500, { error: 'Could not remove the check-in. Try again.' }, responseHeaders);
  }
  if (!data || data.length === 0) {
    return apiJson(404, { error: 'That check-in is already gone.' }, responseHeaders);
  }

  console.info('[api/attendance/:id] check-in removed', {
    attendanceId: id,
    eventId: data[0].event_id,
    memberId: data[0].member_id,
    method: data[0].method,
    actorId: session.id,
  });
  return apiJson(200, { removed: true }, responseHeaders);
};
