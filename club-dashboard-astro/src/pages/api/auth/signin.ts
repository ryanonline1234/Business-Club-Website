import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase';
import { SITE_URL } from '../../../lib/env';
import { safeNextPath, setNextCookie } from '../../../lib/next-redirect';

/**
 * GATE 1 — the Google consent screen.
 *
 * `hd` is a HINT ONLY and is never trusted: it is a query parameter on a URL
 * the browser controls, so a determined user can strip or change it. Its whole
 * job is to make Google's own account chooser hide personal @gmail.com
 * accounts, which is what stops most wrong-account sign-ins before they start.
 * The real enforcement is GATE 2, server-side, in ./callback.ts.
 *
 * `hd` takes exactly one domain or the wildcard `*`. The club has two school
 * domains (@mittymonarch.com for students, @mitty.com for faculty), so `*` is
 * the best available value: it restricts the chooser to Workspace-managed
 * accounts in general rather than to one specific domain.
 */
export const GET: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient(request, responseHeaders);

  // Optional `?next=<same-origin path>`, stashed in an httpOnly cookie for the
  // callback to consume. It cannot ride along as a query parameter because the
  // browser goes to Google in between. Rejected values are simply dropped —
  // see lib/next-redirect.ts for the open-redirect rules. Absent in production
  // today; the /login page has to forward it and that page is not rewritten yet.
  const nextPath = safeNextPath(new URL(request.url).searchParams.get('next'));
  if (nextPath) responseHeaders.append('set-cookie', setNextCookie(nextPath));

  // SITE_URL comes from lib/env: validated at boot, trimmed, trailing slashes
  // stripped — so this never produces the double slash that would stop the
  // redirect URI matching the one registered with Google.
  const redirectTo = `${SITE_URL}/api/auth/callback`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
        hd: '*',
      },
    },
  });

  if (error || !data.url) {
    console.error('[auth/signin] signInWithOAuth failed:', {
      message: error?.message,
      status: error?.status,
      name: error?.name,
    });
    return new Response(null, {
      status: 302,
      headers: { location: `${SITE_URL}/login?error=auth-error` },
    });
  }

  // responseHeaders carries the PKCE code-verifier cookie Supabase just set.
  // It MUST travel with this redirect or the callback has nothing to exchange.
  responseHeaders.set('location', data.url);
  return new Response(null, { status: 302, headers: responseHeaders });
};
