import { SITE_ORIGIN } from './env';

/**
 * "Where was I going before you made me sign in?"
 *
 * WHY THIS EXISTS
 *   A student scans a meeting QR code, lands on /checkin, taps Check In, and —
 *   if they are not signed in — gets a 401. The intended recovery (security_fixes
 *   for api/attendance/checkin.ts) is to send them to
 *   `/login?next=<the checkin url>` and return them to the scan afterwards.
 *   Only the OAuth callback can perform that final redirect, so the round trip
 *   needs a server-side carrier: `next` cannot survive the trip to Google and
 *   back as a query parameter on our own URL.
 *
 *   The carrier is a short-lived, httpOnly cookie set by /api/auth/signin and
 *   consumed once by /api/auth/callback.
 *
 * REMAINING WORK, NOT DOABLE HERE
 *   src/pages/checkin.astro must send a 401 to `/login?next=…`, and
 *   src/pages/login.astro must forward that value to the sign-in link as
 *   `/api/auth/signin?next=…`. Both are .astro pages, owned by the design
 *   rewrite. Until they do, this module is inert — `next` is simply never
 *   present, and every code path behaves exactly as it did before.
 */

/** Ten minutes: long enough to pick a Google account, short enough to be junk. */
export const NEXT_COOKIE_MAX_AGE_SECONDS = 600;

export const NEXT_COOKIE_NAME = 'mbc-next';

/**
 * Validate a caller-supplied `next` and return the path to redirect to, or null.
 *
 * OPEN-REDIRECT DEFENCE. Everything about this value is attacker-controlled: it
 * arrives as a query parameter and ends up in a Location header. It is accepted
 * ONLY as a path on this exact origin:
 *   • must start with a single '/' — "https://evil.com" and "javascript:…" fail
 *   • "//evil.com" and "/\evil.com" are rejected explicitly; both are
 *     protocol-relative URLs after browser normalisation, and both start with '/'
 *   • the resolved origin is compared to SITE_ORIGIN as a belt-and-braces check
 * Auth routes are excluded so a crafted `next` cannot bounce a user back into
 * the sign-in loop or replay an API call.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;

  let url: URL;
  try {
    url = new URL(value, SITE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== SITE_ORIGIN) return null;

  const path = url.pathname;
  if (path.startsWith('/api/')) return null;
  if (path === '/login' || path === '/pending') return null;

  return path + url.search;
}

/** Read one cookie by name. Hand-rolled so this module has no dependencies. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Serialized Set-Cookie storing `path` for the OAuth round trip.
 * Same flags as the session cookies: httpOnly (never readable from script),
 * SameSite=Lax (survives the top-level redirect back from Google), Path=/ so
 * the callback can read it — the same reason commit 2da6c8f exists.
 */
export function setNextCookie(path: string): string {
  return (
    `${NEXT_COOKIE_NAME}=${encodeURIComponent(path)}` +
    `; Path=/; Max-Age=${NEXT_COOKIE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  );
}

/** Serialized Set-Cookie clearing the carrier. Sent on EVERY callback outcome. */
export function clearNextCookie(): string {
  return `${NEXT_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
