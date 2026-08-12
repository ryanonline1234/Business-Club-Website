import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';
import { PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '../../../lib/env';

/**
 * DELETE /api/photos/[id] — officers only. Removes one /about photo.
 *
 * Order matters and is the REVERSE of the upload: DB row first, storage object
 * second, best-effort. The row is what the public page renders from — a row
 * whose object is gone is a broken image on /about, while an object whose row
 * is gone is just invisible bytes in the bucket. So the failure mode we accept
 * is the invisible one: if the storage delete fails, we log it and still
 * report success.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST "photos table missing": Postgres undefined_table, or the schema
 *  cache miss PostgREST reports instead when it never saw the table. */
const TABLE_MISSING_CODES = new Set(['42P01', 'PGRST205']);

export const DELETE: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = params.id;
  if (!id || !UUID_RE.test(id)) {
    // Without this, a non-uuid path segment reaches Postgres and comes back as
    // a 500 "invalid input syntax for type uuid".
    return apiJson(400, { error: 'Invalid photo id' }, responseHeaders);
  }

  // Delete the row and get its storage_path back in one statement — no window
  // where a second request could delete the row between a read and a write.
  const { data, error } = await supabaseAdmin
    .from('photos')
    .delete()
    .eq('id', id)
    .select('id, storage_path');

  if (error) {
    console.error('[api/photos/:id] row delete failed', {
      photoId: id,
      actorId: session.id,
      code: error.code,
      message: error.message,
    });
    if (TABLE_MISSING_CODES.has(error.code)) {
      return apiJson(
        500,
        { error: 'The photo feature needs a database update — run STEPs 16-18' },
        responseHeaders
      );
    }
    return apiJson(500, { error: 'Could not delete the photo' }, responseHeaders);
  }

  if (!data || data.length === 0) {
    return apiJson(404, { error: 'Photo not found' }, responseHeaders);
  }

  // Best-effort object removal. Never throws; a failure leaves an orphaned
  // object in the bucket, which is tolerable (a dangling public ROW is not,
  // and that one is already gone). Duplicated in api/photos/index.ts rather
  // than lifted into src/lib because src/lib is owned by another agent.
  const storagePath = data[0].storage_path as string;
  try {
    const res = await fetch(
      `${PUBLIC_SUPABASE_URL}/storage/v1/object/club-photos/${storagePath}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      }
    );
    if (!res.ok) {
      console.error('[api/photos/:id] storage delete failed — orphaned object', {
        photoId: id,
        storagePath,
        status: res.status,
      });
    }
  } catch (cause) {
    console.error('[api/photos/:id] storage delete threw — orphaned object', {
      photoId: id,
      storagePath,
      cause,
    });
  }

  return apiJson(200, { success: true }, responseHeaders);
};
