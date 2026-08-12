import { createClient } from '@supabase/supabase-js';
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import {
  PUBLIC_SUPABASE_URL,
  PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
} from './env';

// Env values arrive already validated and trimmed by ./env — importing it is
// what makes a deploy with a missing variable fail at boot instead of at the
// first query. Whitespace/newlines are a common copy-paste mistake when
// setting Vercel env vars, so the trim happens there, once, for all five.

// Admin client — BYPASSES RLS. Server-side only, and every endpoint that uses
// it must enforce its own authorization; there is no second line of defence.
export const supabaseAdmin = createClient(PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Drop an auth cookie whose value @supabase/ssr would throw on.
 *
 * WHY THIS EXISTS — it is a real lockout, not a hypothetical. @supabase/ssr
 * stores the session as `base64-<b64>` and decodes it with a strict UTF-8
 * decoder. If those bytes are not valid UTF-8, the decode throws
 * `Invalid UTF-8 sequence` from inside getUser(), which is an unhandled
 * rejection that 500s the route. That includes `/login` and
 * `/api/auth/signout` — the two pages a user would use to recover — so a
 * browser holding one bad cookie is locked out of the entire app with no
 * self-service way back, only "clear cookies in browser settings".
 *
 * The realistic trigger is not tampering: Supabase splits a large session
 * across chunked cookies (`…auth-token.0`, `.1`), and a browser evicting or
 * truncating one chunk leaves exactly this state. Verified against production
 * before the fix: `/login` and `/` both returned 500.
 *
 * Dropping the cookie here degrades it to "signed out", which every route
 * already handles correctly — the user simply lands on /login and signs in
 * again, and the fresh login overwrites the bad cookie.
 *
 * Only `sb-*` values are inspected, and only the `base64-` form is decoded;
 * everything else is passed through untouched so this can never interfere
 * with the PKCE verifier cookie (see the path:'/' note in setAll below).
 */
function isDecodableAuthCookie(name: string, value: string): boolean {
  if (!name.startsWith('sb-') || !value.startsWith('base64-')) return true;
  try {
    const bytes = Buffer.from(value.slice('base64-'.length), 'base64');
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    console.error('[supabase] dropping undecodable auth cookie; treating request as signed out', {
      cookie: name,
    });
    return false;
  }
}

// SSR-aware client that reads/writes the session cookie.
// Pass the request and a mutable Headers object — Supabase will append
// Set-Cookie headers to it during the PKCE exchange and session refresh.
export function createSupabaseServerClient(request: Request, responseHeaders: Headers) {
  return createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        // parseCookieHeader types `value` as possibly-undefined; the client
        // wants string. Coerced here so the cookies object type-checks under
        // `strict` and setAll's parameter stays inferable.
        return parseCookieHeader(request.headers.get('cookie') ?? '')
          .map((cookie) => ({ name: cookie.name, value: cookie.value ?? '' }))
          .filter((cookie) => isDecodableAuthCookie(cookie.name, cookie.value));
      },
      setAll(cookiesToSet: Array<{
        name: string;
        value: string;
        options?: Parameters<typeof serializeCookieHeader>[2];
      }>) {
        cookiesToSet.forEach(({ name, value, options }) => {
          responseHeaders.append(
            'set-cookie',
            serializeCookieHeader(name, value, {
              ...options,
              // path: '/' ensures the PKCE code-verifier cookie is sent to
              // ALL paths including /api/auth/callback, not just the signin path.
              path: '/',
              secure: true,
              sameSite: 'lax',
              httpOnly: true,
            })
          );
        });
      },
    },
  });
}
