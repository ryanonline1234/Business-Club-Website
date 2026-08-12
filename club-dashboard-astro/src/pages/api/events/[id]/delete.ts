import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';

/**
 * DELETE /api/events/[id]/delete — officers only.
 *
 * SOFT delete: the row stays, `status` flips to 'cancelled'. Nothing here ever
 * issues a real DELETE, so attendance rows keep their foreign key and a
 * mistaken cancel is reversible from the table editor.
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
    return apiJson(400, { error: 'Invalid event id' }, responseHeaders);
  }

  const { error } = await supabaseAdmin.from('events').update({ status: 'cancelled' }).eq('id', id);

  if (error) {
    console.error('[api/events/[id]/delete]', error);
    return apiJson(500, { error: 'Could not cancel the event' }, responseHeaders);
  }

  return apiJson(200, { success: true }, responseHeaders);
};
