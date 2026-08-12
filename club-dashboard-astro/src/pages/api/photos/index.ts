import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../lib/auth';
import { PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from '../../../lib/env';

/**
 * POST /api/photos — officers only. Multipart upload of one club photo for the
 * public /about page.
 *
 * Fields:
 *   file     (required)  the image itself
 *   event_id (optional)  uuid of an existing PAST event to attach it to
 *   caption  (optional)  plain text, ≤ 300 characters
 *
 * The file is validated SERVER-SIDE regardless of what the club-photos bucket
 * enforces (public read, 8MB, image mime allow-list). The bucket config can
 * drift and the object URL is public, so nothing un-imagelike may land there:
 *   • type comes from MAGIC BYTES — never the client's mime string or filename
 *   • size ≤ 8MB, checked against the actual bytes received
 *
 * The storage path is photos/<crypto.randomUUID()>.<ext-from-detected-type>.
 * It is NEVER derived from the client filename, so there is no path-traversal
 * or weird-character surface at all — the client names nothing.
 *
 * Write order: storage object first, DB row second. If the row insert fails,
 * the object is best-effort deleted. An orphaned storage object is invisible;
 * a photos row pointing at nothing is a broken image on the public page —
 * that asymmetry decides the order here and in DELETE /api/photos/[id].
 */

/** Matches the club-photos bucket limit. Enforced here too — see above. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTION = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST "photos table missing": Postgres undefined_table, or the schema
 *  cache miss PostgREST reports instead when it never saw the table. */
const TABLE_MISSING_CODES = new Set(['42P01', 'PGRST205']);

interface DetectedImage {
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

/**
 * Identify the image type from the first bytes of the file — the only
 * trustworthy signal, since mime string and filename are both client-chosen.
 *   JPEG  ff d8 ff
 *   PNG   89 50 4e 47
 *   WEBP  52 49 46 46 ("RIFF") …4 size bytes… 57 45 42 50 ("WEBP")
 *   GIF   47 49 46 38 ("GIF8")
 * Anything else (including a file too short to carry a signature) is null.
 */
function detectImageType(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

/** Storage REST endpoint for one object in the club-photos bucket. */
function storageObjectEndpoint(storagePath: string): string {
  return `${PUBLIC_SUPABASE_URL}/storage/v1/object/club-photos/${storagePath}`;
}

/**
 * Best-effort object removal for the insert-failed cleanup path. Never throws.
 * Duplicated in api/photos/[id].ts rather than lifted into src/lib because
 * src/lib is owned by another agent; if a third caller appears, lift it.
 */
async function deleteStorageObjectBestEffort(storagePath: string): Promise<boolean> {
  try {
    const res = await fetch(storageObjectEndpoint(storagePath), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return apiJson(
      400,
      { error: 'Expected multipart form data with a `file` field' },
      responseHeaders
    );
  }

  // ── file: required, image-by-magic-bytes, ≤ 8MB ───────────────────────────
  const file = form.get('file');
  if (!(file instanceof File)) {
    return apiJson(400, { error: 'file is required and must be a file upload' }, responseHeaders);
  }
  if (file.size > MAX_FILE_BYTES) {
    return apiJson(400, { error: 'file is too large — the limit is 8MB' }, responseHeaders);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    // file.size is client-reported metadata; the byte count is the truth.
    return apiJson(400, { error: 'file is too large — the limit is 8MB' }, responseHeaders);
  }

  const detected = detectImageType(bytes);
  if (!detected) {
    return apiJson(
      400,
      { error: 'file is not a recognized image — JPEG, PNG, WEBP, or GIF only' },
      responseHeaders
    );
  }

  // ── event_id: optional, but when present it must be a real PAST event ─────
  const rawEventId = form.get('event_id');
  if (rawEventId !== null && typeof rawEventId !== 'string') {
    return apiJson(400, { error: 'event_id must be a text field' }, responseHeaders);
  }
  let eventId: string | null = null;
  if (typeof rawEventId === 'string' && rawEventId.trim() !== '') {
    const candidate = rawEventId.trim();
    if (!UUID_RE.test(candidate)) {
      return apiJson(400, { error: 'event_id is not a valid event id' }, responseHeaders);
    }

    const { data: event, error: eventError } = await supabaseAdmin
      .from('events')
      .select('id, start_time')
      .eq('id', candidate)
      .maybeSingle();

    if (eventError) {
      console.error('[api/photos] event lookup failed', {
        eventId: candidate,
        actorId: session.id,
        code: eventError.code,
        message: eventError.message,
      });
      return apiJson(500, { error: 'Could not look up that event' }, responseHeaders);
    }
    if (!event) {
      return apiJson(400, { error: 'event_id does not match an existing event' }, responseHeaders);
    }

    // Photos document history: only events that have already started qualify,
    // same rule as PATCH /api/events/:id/recap.
    const startMs = Date.parse(event.start_time as string);
    if (!(startMs < Date.now())) {
      return apiJson(
        400,
        { error: 'Photos can only be attached to past events' },
        responseHeaders
      );
    }
    eventId = candidate;
  }

  // ── caption: optional plain text ──────────────────────────────────────────
  const rawCaption = form.get('caption');
  if (rawCaption !== null && typeof rawCaption !== 'string') {
    return apiJson(400, { error: 'caption must be a text field' }, responseHeaders);
  }
  const caption =
    typeof rawCaption === 'string' && rawCaption.trim() !== '' ? rawCaption.trim() : null;
  if (caption !== null && caption.length > MAX_CAPTION) {
    return apiJson(
      400,
      { error: `caption must be ${MAX_CAPTION} characters or fewer` },
      responseHeaders
    );
  }

  // ── upload the object, then insert the row ────────────────────────────────
  const storagePath = `photos/${crypto.randomUUID()}.${detected.ext}`;

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(storageObjectEndpoint(storagePath), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': detected.mime,
        // Short TTL ON PURPOSE, and it must stay short: Supabase serves
        // public-bucket objects through a CDN, and this header (the same
        // `cache-control: max-age=<s>` the official storage-js client sends;
        // default 1 hour) is what browsers — and, on the basic CDN, edge
        // caches — hold the bytes for. These are photos of students: when an
        // officer deletes one, ~5 minutes is the acceptable ceiling on cached
        // copies outliving the delete, and cheap re-fetches on a low-traffic
        // page are the right price for that.
        'cache-control': 'max-age=300',
      },
      body: bytes,
    });
  } catch (cause) {
    console.error('[api/photos] storage upload threw', { storagePath, actorId: session.id, cause });
    return apiJson(500, { error: 'Could not store the photo' }, responseHeaders);
  }

  if (!uploadResponse.ok) {
    const detail = (await uploadResponse.text().catch(() => '')).slice(0, 500);
    console.error('[api/photos] storage upload rejected', {
      storagePath,
      actorId: session.id,
      status: uploadResponse.status,
      detail,
    });
    return apiJson(500, { error: 'Could not store the photo' }, responseHeaders);
  }

  const { data, error } = await supabaseAdmin
    .from('photos')
    .insert({
      event_id: eventId,
      storage_path: storagePath,
      caption,
      uploaded_by: session.id,
    })
    .select()
    .single();

  if (error) {
    console.error('[api/photos] row insert failed — cleaning up storage object', {
      storagePath,
      actorId: session.id,
      code: error.code,
      message: error.message,
    });

    const cleaned = await deleteStorageObjectBestEffort(storagePath);
    if (!cleaned) {
      // Tolerable: an orphaned object in the bucket is invisible to users.
      console.error('[api/photos] cleanup delete also failed — orphaned object', { storagePath });
    }

    if (TABLE_MISSING_CODES.has(error.code)) {
      return apiJson(
        500,
        { error: 'The photo feature needs a database update — run STEPs 16-18' },
        responseHeaders
      );
    }
    return apiJson(500, { error: 'Could not save the photo' }, responseHeaders);
  }

  const url = `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/club-photos/${storagePath}`;
  return apiJson(201, { data: { ...data, url } }, responseHeaders);
};
