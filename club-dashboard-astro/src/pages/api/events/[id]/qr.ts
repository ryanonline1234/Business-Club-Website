import type { APIRoute } from 'astro';
import { generateEventQR, QR_TOKEN_TTL_SECONDS } from '../../../../lib/qrcode';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiJson, apiRequireOfficer } from '../../../../lib/auth';

/**
 * GET /api/events/[id]/qr — mint a check-in QR code for an event.
 *
 * SECURITY CONTRACT — read before editing.
 *   This endpoint MINTS A BEARER TOKEN. Anyone who can call it can produce a
 *   signed check-in token for any event whose UUID they know, so it is gated on
 *   apiRequireOfficer: only admins and treasurers project QR codes, and nobody
 *   else has a reason to mint one. It previously had no session check at all.
 *
 *   The response body contains that token (inside the QR image), so it is
 *   marked no-store — a cached QR is a token sitting in a shared cache.
 *
 * The token lives 15 minutes (QR_TOKEN_TTL_SECONDS, owned by lib/qrcode.ts).
 * `expires_at` / `expires_in` are returned so the QR modal CAN silently
 * re-fetch before the projected code goes stale.
 *
 * ⚠ IT DOES NOT DO SO YET. src/pages/calendar.astro fetches this route once per
 * modal open and ignores both fields, so a projected code dies mid-meeting.
 * That page is owned by the design rewrite; see the note on
 * QR_TOKEN_TTL_SECONDS in src/lib/qrcode.ts. The same handler also does
 * `if (!res.ok) return;`, so a non-officer clicking an event chip now gets a
 * completely silent dead click instead of the 403 message below.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * When check-in closes. Mirrors src/pages/api/attendance/checkin.ts — there is
 * no point issuing a code whose every scan would be rejected. Keep the two in
 * sync; they cannot share a module without editing src/lib/**, which this
 * change is not allowed to touch.
 *
 * Deliberately asymmetric with checkin.ts: that route also refuses check-ins
 * more than 30 minutes BEFORE start_time, but an officer setting up a room
 * early should still be able to open the modal, so no lower bound here.
 * ──────────────────────────────────────────────────────────────────────────── */
const CLOSES_AFTER_END_MS = 2 * 60 * 60 * 1000;
const ASSUMED_LENGTH_MS = 4 * 60 * 60 * 1000;

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Unix ms after which check-in is closed, or null when start_time is missing or
 * unparseable. An end_time at or before start_time is treated as absent (bad
 * data — fall back to the 4-hour rule) so a typo cannot make a live event
 * un-QR-able.
 */
function checkinClosesAt(startTime: unknown, endTime: unknown): number | null {
  const start = parseTime(startTime);
  if (start === null) return null;

  const end = parseTime(endTime);
  return end === null || end <= start ? start + ASSUMED_LENGTH_MS : end + CLOSES_AFTER_END_MS;
}

export const GET: APIRoute = async ({ params, request }) => {
  const responseHeaders = new Headers();
  // Set before the guard so every response off this route carries it, and so
  // apiJson/apiError copy it through.
  responseHeaders.set('cache-control', 'no-store');

  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = params.id;
  if (!id) return apiJson(400, { error: 'Missing id' }, responseHeaders);

  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .select('id, title, start_time, end_time, status')
    .eq('id', id)
    .maybeSingle();

  if (eventError) {
    console.error('[events/qr] event lookup failed', {
      eventId: id,
      message: eventError.message,
      code: eventError.code,
    });
    return apiJson(500, { error: 'Could not load the event. Try again.' }, responseHeaders);
  }

  if (!event) return apiJson(404, { error: 'Event not found' }, responseHeaders);

  if (event.status !== 'active') {
    return apiJson(
      409,
      {
        error: 'This event is cancelled or completed, so it cannot accept check-ins.',
        reason: 'event_not_active',
      },
      responseHeaders
    );
  }

  const closesAt = checkinClosesAt(event.start_time, event.end_time);
  if (closesAt === null) {
    console.error('[events/qr] event has an unparseable start_time', {
      eventId: event.id,
      startTime: event.start_time,
    });
    return apiJson(500, { error: 'Could not load the event. Try again.' }, responseHeaders);
  }

  if (Date.now() > closesAt) {
    return apiJson(
      409,
      {
        error: 'This event is over, so check-in has closed.',
        reason: 'checkin_closed',
        closed_at: new Date(closesAt).toISOString(),
      },
      responseHeaders
    );
  }

  // Stamped BEFORE minting so the reported expiry is never later than the
  // token's real exp claim; a client refreshing on this value refreshes early,
  // which is the safe direction.
  const issuedAt = Date.now();
  const expiresAt = issuedAt + QR_TOKEN_TTL_SECONDS * 1000;

  // siteUrl comes from the validated SITE_URL inside generateEventQR — no
  // `import.meta.env.SITE_URL ?? 'http://localhost:3000'` fallback, which used
  // to bake localhost into production QR codes when the variable was unset.
  let qr: string;
  try {
    qr = await generateEventQR(event.id);
  } catch (error) {
    console.error('[events/qr] QR generation failed', {
      eventId: event.id,
      message: error instanceof Error ? error.message : String(error),
    });
    return apiJson(500, { error: 'Could not generate the QR code. Try again.' }, responseHeaders);
  }

  console.info('[events/qr] issued check-in token', {
    eventId: event.id,
    issuedBy: session.id,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  return apiJson(
    200,
    {
      qr,
      event: { id: event.id, title: event.title },
      /** ISO timestamp at which the embedded token stops verifying. */
      expires_at: new Date(expiresAt).toISOString(),
      /** Same thing in seconds, for a setTimeout-driven silent re-fetch. */
      expires_in: QR_TOKEN_TTL_SECONDS,
    },
    responseHeaders
  );
};
