import type { APIRoute } from 'astro';
import { createSupabaseServerClient } from '../../../lib/supabase';
import { checkSafeNavigation, previewCookieHeader } from '../../../lib/auth';
import { SITE_URL } from '../../../lib/env';

/**
 * Sign out. Clears the Supabase session cookie and returns to /login.
 *
 * WHY GET IS STILL EXPORTED
 *   The sidebar signs out with a plain `<a href="/api/auth/signout">`
 *   (src/components/Sidebar.astro:49), and src/components is owned by the page
 *   rewrite. Removing GET would break sign-out outright, so instead GET is
 *   hardened: checkSafeNavigation rejects a cross-site trigger such as
 *   `<img src="https://…/api/auth/signout">`, which sends no Origin header but
 *   does send `Sec-Fetch-Site: cross-site`. POST is exported alongside it so the
 *   rewritten sidebar can switch to a form/fetch without another server change;
 *   POST additionally benefits from the cookie's SameSite=lax.
 *
 * SITE_URL comes from lib/env — validated at boot, trimmed, trailing slashes
 * stripped. The previous `import.meta.env.SITE_URL` was untrimmed and undefined
 * at runtime whenever the variable was only set at build time: a pasted Vercel
 * value with a trailing newline makes `headers.set('location', …)` throw
 * (a 500 AFTER the session was already cleared), and an unset one emits
 * `Location: undefined/login`, which browsers resolve relative to the current
 * path and 404.
 */
async function signOut(request: Request): Promise<Response> {
  const responseHeaders = new Headers();

  const crossSite = checkSafeNavigation(request, responseHeaders);
  if (crossSite) return crossSite;

  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { error } = await supabase.auth.signOut();
  if (error) {
    // Non-fatal: the cookie-clearing Set-Cookie headers are already on
    // responseHeaders, so the browser session goes away either way.
    console.error('[auth/signout] signOut returned an error:', {
      message: error.message,
      status: error.status,
    });
  }

  // Sign-out clears the officer "view as student" preview too.
  //
  // WHY IT MATTERS: `mbc-view` is a session cookie scoped to the browser, not
  // to the account, and it is HttpOnly — no page script can reach it. Left
  // behind, it survives into the NEXT sign-in on this browser. On the club's
  // shared laptop that means officer A previews, signs out, and officer B signs
  // in already in student view they never asked for. It also makes "sign out
  // and back in" — the first thing anyone tries when a UI looks stuck — a
  // genuine escape hatch rather than a no-op.
  //
  // Appended, not set: supabase.auth.signOut() has already put its own
  // cookie-clearing Set-Cookie values on these headers.
  responseHeaders.append('set-cookie', previewCookieHeader(false));

  responseHeaders.set('location', `${SITE_URL}/login`);
  return new Response(null, { status: 302, headers: responseHeaders });
}

export const GET: APIRoute = async ({ request }) => signOut(request);
export const POST: APIRoute = async ({ request }) => signOut(request);
