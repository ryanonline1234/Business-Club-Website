import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';

/**
 * DELETE /api/announcements/[id] — officers only.
 *
 * Hard delete, unchanged: announcements carry no dependent rows.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELETE: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    // Without this, a non-uuid path segment reaches Postgres and comes back as
    // a 500 "invalid input syntax for type uuid".
    return apiJson(400, { error: 'Invalid announcement id' }, responseHeaders);
  }

  const { error } = await supabaseAdmin.from('announcements').delete().eq('id', id);

  if (error) {
    console.error('[api/announcements/[id]]', error);
    return apiJson(500, { error: 'Could not delete the announcement' }, responseHeaders);
  }

  return apiJson(200, { success: true }, responseHeaders);
};
