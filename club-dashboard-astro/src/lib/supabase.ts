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
        return parseCookieHeader(request.headers.get('cookie') ?? '').map((cookie) => ({
          name: cookie.name,
          value: cookie.value ?? '',
        }));
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
