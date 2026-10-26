/**
 * GET /activities/<slug>/<path> — serves one file of a meeting activity
 * (src/lib/activities.ts has the registry and the rules).
 *
 *   /activities/website-hunt       → 308 to /activities/website-hunt/ (the
 *                                    page's relative links need the slash)
 *   /activities/website-hunt/      → its index.html
 *   /activities/website-hunt/x/y.z → that file, if it is in the bundle
 *
 * GUARD BY AUDIENCE. 'public' activities have NO GUARD, by design — like
 * /about, they are for people who may not be signed in (members opening the
 * activity on a phone mid-meeting). 'officers' activities go through
 * requireOfficer before anything is served, 404s included; a signed-out
 * officer is sent to /login?next=<this path> and comes straight back.
 *
 * Every response carries a CSP that keeps activity scripts from talking to
 * the API (connect-src 'none') or submitting forms anywhere (form-action
 * 'none'), plus noindex: the demo businesses are fictional and should never
 * turn up in a search.
 */
import type { APIRoute } from 'astro';
import { requireOfficer } from '../../../lib/auth';
import { activityFile, findActivity } from '../../../lib/activities';

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export const GET: APIRoute = async ({ params, request, redirect, url }) => {
  const activity = findActivity(params.slug ?? '');
  if (!activity) return notFound();

  const responseHeaders = new Headers();
  if (activity.audience === 'officers') {
    await requireOfficer(request, responseHeaders, redirect, url.pathname);
  }

  const rest = params.path ?? '';
  if (rest === '' && !url.pathname.endsWith('/')) return redirect(`/activities/${activity.slug}/`, 308);

  const file = activityFile(activity, rest === '' ? 'index.html' : rest);
  if (!file) return notFound();

  responseHeaders.set('content-type', file.type);
  responseHeaders.set('content-security-policy', CSP);
  responseHeaders.set('x-content-type-options', 'nosniff');
  responseHeaders.set('x-robots-tag', 'noindex, nofollow');
  responseHeaders.set(
    'cache-control',
    activity.audience === 'public'
      ? 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'
      : 'private, no-store'
  );
  // The Headers object itself, so refreshed session Set-Cookie values survive
  // (same as attendance.pdf.ts).
  return new Response(file.body, { status: 200, headers: responseHeaders });
};
