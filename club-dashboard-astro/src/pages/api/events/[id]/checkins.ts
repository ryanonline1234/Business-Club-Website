import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';

/**
 * GET /api/events/[id]/checkins — officers only. `{ count }` and nothing else.
 *
 * Feeds the live tally on /calendar's Present screen, which polls this every
 * few seconds while the code is projected. It returns a NUMBER, never names:
 * the projected surface is seen by the whole room, and "no student names ever
 * appear here" is a rule of that screen, not an accident of its layout.
 *
 * Officer-gated because its only caller is Present mode, an officer screen —
 * not as a secrecy boundary: approved members already see the same count on
 * /calendar. Only attendance ROWS (who, when) are officer-only; a member only
 * ever sees their own (/attendance). no-store so a shared cache can never
 * serve a stale number to the projector.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: APIRoute = async ({ params, request }) => {
  const responseHeaders = new Headers();
  responseHeaders.set('cache-control', 'no-store');

  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    return apiJson(400, { error: 'Invalid event id' }, responseHeaders);
  }

  const { count, error } = await supabaseAdmin
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', id);

  if (error || count === null) {
    console.error('[api/events/[id]/checkins] count failed', {
      eventId: id,
      message: error?.message,
      code: error?.code,
    });
    return apiJson(500, { error: 'Could not count check-ins' }, responseHeaders);
  }

  return apiJson(200, { count }, responseHeaders);
};
