import { createSupabaseServerClient, supabaseAdmin } from './supabase';
import { SITE_ORIGIN } from './env';

/**
 * The session layer. Every page and every API route goes through one of the
 * guards below — no route hand-rolls its own role check, because the
 * copy-paste pattern is exactly how endpoints ended up unauthenticated.
 */

export type MemberRole = 'member' | 'treasurer' | 'admin';
export type MemberStatus = 'pending' | 'approved' | 'rejected';

/**
 * How the profile row read went. /pending needs this to tell "a Supabase blip
 * parked you here" apart from "you are genuinely awaiting approval":
 *   'ok'      — row read successfully; role and status are real
 *   'missing' — authenticated, but no profiles row exists for this user
 *   'error'   — the query failed (network, RLS, or a missing `status` column
 *               because the SQL migration has not been applied yet)
 * In both non-'ok' cases role/status are forced to the least-privileged values.
 */
export type ProfileState = 'ok' | 'missing' | 'error';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: MemberRole;
  status: MemberStatus;
  profileState: ProfileState;
  /** status === 'approved' */
  isApproved: boolean;
  /** approved AND role is admin or treasurer. */
  isOfficer: boolean;
  /** approved AND role is admin. */
  isAdmin: boolean;
}

/** Astro.redirect — accepting the narrow shape keeps these testable. */
export type RedirectFn = (path: string) => Response;

/** Result of an API guard. Check `ok` before using either branch. */
export type ApiGuardResult =
  | { ok: true; session: SessionUser }
  | { ok: false; response: Response };

const ROLES: readonly MemberRole[] = ['member', 'treasurer', 'admin'];
const STATUSES: readonly MemberStatus[] = ['pending', 'approved', 'rejected'];

function normalizeRole(value: unknown): MemberRole {
  return ROLES.includes(value as MemberRole) ? (value as MemberRole) : 'member';
}

function normalizeStatus(value: unknown): MemberStatus {
  return STATUSES.includes(value as MemberStatus) ? (value as MemberStatus) : 'pending';
}

function buildSessionUser(args: {
  id: string;
  email: string;
  name: string | null;
  role: MemberRole;
  status: MemberStatus;
  profileState: ProfileState;
}): SessionUser {
  const isApproved = args.status === 'approved';
  return {
    ...args,
    isApproved,
    isOfficer: isApproved && (args.role === 'admin' || args.role === 'treasurer'),
    isAdmin: isApproved && args.role === 'admin',
  };
}

/**
 * Resolve the current user, or null when nobody is signed in.
 *
 * FAILS CLOSED. If the profiles row is missing or the query errors, the caller
 * gets role 'member' + status 'pending' — never access. A transient Supabase
 * failure therefore parks people on /pending rather than opening the app; that
 * is the correct direction to fail, and `profileState` lets /pending say so.
 *
 * Pass Astro.response.headers (pages) or the Headers object you will attach to
 * your Response (API routes) as responseHeaders, so refreshed session cookies
 * reach the browser.
 */
export async function getSession(
  request: Request,
  responseHeaders: Headers
): Promise<SessionUser | null> {
  const supabase = createSupabaseServerClient(request, responseHeaders);

  // getUser() validates the JWT with Supabase — more reliable than getSession()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  const email = user.email ?? '';

  // Admin client so RLS never silently blocks the profile fetch.
  // maybeSingle() so "no row" comes back as data:null WITHOUT an error, which
  // is what lets us tell 'missing' apart from 'error'.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('name, role, status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error(
      '[auth/getSession] profile query failed — failing closed to pending.',
      { userId: user.id, message: profileError.message, code: profileError.code }
    );
    return buildSessionUser({
      id: user.id,
      email,
      name: null,
      role: 'member',
      status: 'pending',
      profileState: 'error',
    });
  }

  if (!profile) {
    console.error(
      '[auth/getSession] authenticated user has no profiles row — failing closed to pending.',
      { userId: user.id, email }
    );
    return buildSessionUser({
      id: user.id,
      email,
      name: null,
      role: 'member',
      status: 'pending',
      profileState: 'missing',
    });
  }

  return buildSessionUser({
    id: user.id,
    email,
    name: (profile.name as string | null) ?? null,
    role: normalizeRole(profile.role),
    status: normalizeStatus(profile.status),
    profileState: 'ok',
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * PAGE GUARDS — these THROW an Astro redirect. Call them as the first
 * statement of a page's frontmatter and never catch them.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Any signed-in user, approved or not. Used only by /pending. */
export async function requireSession(
  request: Request,
  responseHeaders: Headers,
  redirect: RedirectFn
): Promise<SessionUser> {
  const user = await getSession(request, responseHeaders);
  if (!user) throw redirect('/login');
  return user;
}

/** Signed in AND approved. Used by every dashboard page. */
export async function requireApproved(
  request: Request,
  responseHeaders: Headers,
  redirect: RedirectFn
): Promise<SessionUser> {
  const user = await requireSession(request, responseHeaders, redirect);
  if (!user.isApproved) throw redirect('/pending');
  return user;
}

/** Approved AND admin or treasurer. Non-officers bounce to the dashboard. */
export async function requireOfficer(
  request: Request,
  responseHeaders: Headers,
  redirect: RedirectFn
): Promise<SessionUser> {
  const user = await requireApproved(request, responseHeaders, redirect);
  if (!user.isOfficer) throw redirect('/');
  return user;
}

/**
 * @deprecated Compatibility shim for the pages that have not been rewritten
 * yet. Use requireApproved / requireOfficer / requireSession. Delete once no
 * .astro file imports it.
 */
export async function requireAuth(
  request: Request,
  responseHeaders: Headers,
  redirect: RedirectFn
): Promise<SessionUser> {
  return await requireApproved(request, responseHeaders, redirect);
}

/* ────────────────────────────────────────────────────────────────────────────
 * API GUARDS — these RETURN, never throw. First statement of every endpoint.
 * ──────────────────────────────────────────────────────────────────────────── */

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * JSON error response that preserves any Set-Cookie headers Supabase appended
 * to responseHeaders (session refresh must not be lost on a rejection).
 * Copied header-by-header because Headers.forEach folds multiple Set-Cookie
 * values into one comma-joined string, which corrupts them.
 */
function apiError(status: number, body: Record<string, unknown>, responseHeaders?: Headers): Response {
  const headers = new Headers({ 'content-type': 'application/json' });

  if (responseHeaders) {
    responseHeaders.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') return;
      headers.set(key, value);
    });
    headers.set('content-type', 'application/json');

    const getSetCookie = (responseHeaders as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    const cookies = typeof getSetCookie === 'function' ? getSetCookie.call(responseHeaders) : [];
    for (const cookie of cookies) headers.append('set-cookie', cookie);
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function pathOf(request: Request): string | null {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

/**
 * True when the browser itself says this request came from somewhere else.
 *
 * Two independent signals, either of which is conclusive:
 *   • Origin — sent on every cross-origin fetch/XHR and on form POSTs. Matched
 *     against SITE_URL's origin OR the origin the request was actually made to;
 *     the second alternative is what keeps Vercel preview deployments, whose
 *     host differs from SITE_URL, working.
 *   • Sec-Fetch-Site — sent by every current browser on EVERY request, including
 *     GET navigations and `<img src>` loads, which carry no Origin header at
 *     all. 'none' means the user typed the URL or used a bookmark.
 *
 * Neither header present (curl, server-to-server, an ancient browser) reads as
 * same-site, exactly as before: this is defence-in-depth on top of the session
 * cookie's SameSite=lax, not the authentication boundary.
 */
function isCrossSiteRequest(request: Request): { crossSite: boolean; why: string | null } {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { crossSite: true, why: `sec-fetch-site: ${secFetchSite}` };
  }

  const origin = request.headers.get('origin');
  if (!origin) return { crossSite: false, why: null };

  let selfOrigin: string | null = null;
  try {
    selfOrigin = new URL(request.url).origin;
  } catch {
    selfOrigin = null;
  }

  if (origin === SITE_ORIGIN || (selfOrigin !== null && origin === selfOrigin)) {
    return { crossSite: false, why: null };
  }

  return { crossSite: true, why: `origin: ${origin} (expected ${SITE_ORIGIN} or ${selfOrigin})` };
}

/**
 * CSRF defence-in-depth for the JSON API. Only mutating methods are checked;
 * GET endpoints here are reads.
 */
function checkOrigin(request: Request, responseHeaders: Headers): Response | null {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return null;

  const { crossSite, why } = isCrossSiteRequest(request);
  if (!crossSite) return null;

  console.error('[auth/checkOrigin] rejected cross-origin mutation', {
    why,
    method: request.method,
    path: pathOf(request),
  });

  return apiError(403, { error: 'Invalid origin' }, responseHeaders);
}

/**
 * The same check for a route that changes state on a GET — today that is only
 * /api/auth/signout, which must stay a GET because the sidebar signs out with a
 * plain `<a href>` and src/components is owned by the page rewrite.
 *
 * checkOrigin alone would not help there: a cross-site `<img src=".../signout">`
 * sends NO Origin header, so only Sec-Fetch-Site catches it. Returns null when
 * the request is fine, or the Response to send when it is not.
 */
export function checkSafeNavigation(request: Request, responseHeaders: Headers): Response | null {
  const { crossSite, why } = isCrossSiteRequest(request);
  if (!crossSite) return null;

  console.error('[auth/checkSafeNavigation] rejected cross-site state change', {
    why,
    method: request.method,
    path: pathOf(request),
  });

  return apiError(403, { error: 'Invalid origin' }, responseHeaders);
}

/**
 * Signed in AND approved, plus the CSRF origin check on mutating methods.
 *
 *   const guard = await apiRequireApproved(request, responseHeaders);
 *   if (!guard.ok) return guard.response;
 *   const session = guard.session;
 */
export async function apiRequireApproved(
  request: Request,
  responseHeaders: Headers
): Promise<ApiGuardResult> {
  const originError = checkOrigin(request, responseHeaders);
  if (originError) return { ok: false, response: originError };

  const session = await getSession(request, responseHeaders);
  if (!session) {
    return { ok: false, response: apiError(401, { error: 'Unauthorized' }, responseHeaders) };
  }
  if (!session.isApproved) {
    return {
      ok: false,
      response: apiError(
        403,
        { error: 'Account pending approval', status: session.status },
        responseHeaders
      ),
    };
  }
  return { ok: true, session };
}

/** apiRequireApproved plus role in ('admin', 'treasurer'). */
export async function apiRequireOfficer(
  request: Request,
  responseHeaders: Headers
): Promise<ApiGuardResult> {
  const guard = await apiRequireApproved(request, responseHeaders);
  if (!guard.ok) return guard;
  if (!guard.session.isOfficer) {
    return { ok: false, response: apiError(403, { error: 'Forbidden' }, responseHeaders) };
  }
  return guard;
}

/** apiRequireApproved plus role === 'admin'. */
export async function apiRequireAdmin(
  request: Request,
  responseHeaders: Headers
): Promise<ApiGuardResult> {
  const guard = await apiRequireApproved(request, responseHeaders);
  if (!guard.ok) return guard;
  if (!guard.session.isAdmin) {
    return { ok: false, response: apiError(403, { error: 'Forbidden' }, responseHeaders) };
  }
  return guard;
}

/**
 * Same JSON + Set-Cookie shape the guards use, so endpoints do not hand-roll
 * their own Response construction and accidentally drop refreshed cookies.
 */
export function apiJson(
  status: number,
  body: Record<string, unknown>,
  responseHeaders?: Headers
): Response {
  return apiError(status, body, responseHeaders);
}
