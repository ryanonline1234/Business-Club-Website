import type { APIRoute } from 'astro';
import { apiJson, apiRequireActualOfficer_previewToggleOnly, previewCookieHeader } from '../../lib/auth';
import { safeNextPath } from '../../lib/next-redirect';

/**
 * POST /api/preview — turn the officer-only "view as student" preview on/off.
 *
 *   { "mode": "student" }  → render the app as a plain member
 *   { "mode": "officer" }  → back to the real role
 *
 * TWO BODY SHAPES, ON PURPOSE
 *   • JSON            → 200, and the client reloads. Used by the "View as
 *                       student" button in the topbar.
 *   • form-urlencoded → 303 back to the page the officer was on. Used by the
 *                       EXIT control in the preview banner.
 *
 *   The exit takes the form path because it must not depend on JavaScript. The
 *   cookie it has to clear is HttpOnly, so no page script can clear it as a
 *   fallback, and there is no other route that clears it — an officer whose
 *   script chunk failed to load would be held in student view with nothing on
 *   the page able to get them out. A plain <form> submit works with the script
 *   dead. (Signing out clears it too; that is the second escape hatch.)
 *
 *   The way IN can stay JS-only: if that fetch fails, nothing has changed and
 *   the officer keeps their normal view.
 *
 * WHY apiRequireActualOfficer_previewToggleOnly AND NOT apiRequireOfficer
 *   While the preview is on, session.isOfficer is false — that is the entire
 *   point of it. apiRequireOfficer would therefore 403 the very request that
 *   turns the preview back OFF, stranding the officer in student view with no
 *   way out but hand-clearing cookies. The guard used here checks the real
 *   profiles role, which the preview never downgrades. This route is the only
 *   place that guard belongs.
 *
 *   Everything else still comes from the shared guard: it runs the CSRF/origin
 *   check (POST is a mutating method, and a form POST carries both Origin and
 *   Sec-Fetch-Site, so the check applies identically to either body shape) and
 *   rejects anyone not signed in and approved. A non-officer gets 403 and NO
 *   cookie is set — and even if one were, the downgrade in buildSessionUser()
 *   is honoured only for real officers, so it could not grant them anything.
 */

/** The page the officer submitted from, or null. Validated by safeNextPath. */
function refererPath(request: Request): string | null {
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();

  const guard = await apiRequireActualOfficer_previewToggleOnly(request, responseHeaders);
  if (!guard.ok) return guard.response;

  const contentType = request.headers.get('content-type') ?? '';
  const isForm =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  let mode: unknown;

  if (isForm) {
    try {
      mode = (await request.formData()).get('mode');
    } catch {
      return apiJson(400, { error: 'Invalid form body' }, responseHeaders);
    }
  } else {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
    }
    mode =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).mode
        : undefined;
  }

  if (mode !== 'student' && mode !== 'officer') {
    return apiJson(400, { error: "mode must be 'student' or 'officer'" }, responseHeaders);
  }

  // Appended to the same Headers the guard used, so both responses below carry
  // this alongside any refreshed Supabase session cookie instead of replacing it.
  responseHeaders.append('set-cookie', previewCookieHeader(mode === 'student'));

  if (isForm) {
    // 303 so the browser re-GETs (no resubmission on refresh) and the officer
    // lands back where they were. The Location is root-relative and passes
    // through safeNextPath, which rejects anything that is not a plain path on
    // this origin — a Referer is attacker-influenceable and must never reach a
    // Location header unchecked. Constructing the Response from these headers
    // directly, as /api/auth/signout does, preserves every appended Set-Cookie.
    responseHeaders.set('location', safeNextPath(refererPath(request)) ?? '/');
    return new Response(null, { status: 303, headers: responseHeaders });
  }

  return apiJson(200, { mode, viewingAsStudent: mode === 'student' }, responseHeaders);
};
