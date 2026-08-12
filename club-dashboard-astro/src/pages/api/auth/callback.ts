import type { APIRoute } from 'astro';
import { createSupabaseServerClient, supabaseAdmin } from '../../../lib/supabase';
import { SITE_URL, isSchoolEmail } from '../../../lib/env';
import {
  NEXT_COOKIE_NAME,
  clearNextCookie,
  readCookie,
  safeNextPath,
} from '../../../lib/next-redirect';

/**
 * OAuth callback — GATE 2 (domain enforcement) and GATE 2b (profile creation).
 *
 * ORDER OF OPERATIONS MATTERS HERE. Read before editing:
 *
 *   1. Exchange the PKCE code for a session.
 *   2. Read any existing profile row. This is a READ; nothing is written before
 *      the domain decision is made.
 *   3. Domain gate. A non-school address is rejected UNLESS an existing profile
 *      row says status='approved' — the grandfather clause (see below).
 *   4. Profile fallback: insert a missing row (status decided by the domain
 *      rule, matching the DB trigger's auto-approval), or refresh email/name
 *      on an existing one — the update NEVER touches role or status.
 *   5. Read status back and route: approved → /, everything else → /pending.
 *
 * Redirects use a small FIXED set of error codes — ?error=domain |
 * auth-error | pending — and never carry provider error text (security_fixes
 * #12: the old `&detail=<raw supabase error>` leaked internal auth-provider
 * messages into browser history, referrer headers and any URL-capturing log,
 * and was one careless template edit away from being reflected into the page).
 * The detail stays in console.error, where the Vercel function log keeps it.
 */

/** The only error codes this route may put in a URL. */
type AuthErrorCode = 'domain' | 'auth-error' | 'pending';

/**
 * 302 that carries `responseHeaders`, so every Set-Cookie Supabase appended
 * during the exchange (session set) or the sign-out (session cleared) actually
 * reaches the browser. Mutating the same Headers object rather than building a
 * new one is deliberate: Headers.forEach folds multiple Set-Cookie values into
 * one comma-joined string, which corrupts them.
 */
function redirectWithCookies(location: string, responseHeaders: Headers): Response {
  responseHeaders.set('location', location);
  return new Response(null, { status: 302, headers: responseHeaders });
}

function loginError(code: AuthErrorCode, responseHeaders: Headers): Response {
  return redirectWithCookies(`${SITE_URL}/login?error=${code}`, responseHeaders);
}

/** Google's display name, falling back to the email local-part. */
function displayNameFor(metadata: unknown, email: string): string | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const fromMeta =
    typeof meta.full_name === 'string'
      ? meta.full_name
      : typeof meta.name === 'string'
        ? meta.name
        : '';
  const name = fromMeta.trim() || email.split('@')[0]?.trim() || '';
  return name === '' ? null : name;
}

export const GET: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  /* Post-sign-in destination, stashed by /api/auth/signin before the trip to
   * Google. Re-validated here rather than trusted: the cookie is httpOnly, but
   * "it was ours when we set it" is not a reason to skip an open-redirect check
   * on a value that is about to become a Location header. Consumed once —
   * cleared on EVERY exit path, including the rejections below. */
  const rawNext = readCookie(request, NEXT_COOKIE_NAME);
  const nextPath = safeNextPath(rawNext);
  if (rawNext !== null) responseHeaders.append('set-cookie', clearNextCookie());

  if (!code) {
    // Also the path taken when the user cancels at Google's consent screen,
    // in which case the provider sends ?error=access_denied instead of ?code.
    console.error('[auth/callback] no authorization code on the callback URL', {
      providerError: url.searchParams.get('error'),
      providerErrorCode: url.searchParams.get('error_code'),
    });
    return loginError('auth-error', responseHeaders);
  }

  const supabase = createSupabaseServerClient(request, responseHeaders);

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    // Server-side only. Useful in the Vercel function log; never in the URL.
    console.error('[auth/callback] exchangeCodeForSession failed:', {
      message: error?.message,
      status: error?.status,
      name: error?.name,
      hasCode: true,
      cookieHeader: request.headers.get('cookie')?.replace(/=([^;]+)/g, '=[redacted]') ?? 'none',
    });
    return loginError('auth-error', responseHeaders);
  }

  const userId = data.user.id;
  const userEmail = data.user.email ?? '';
  const userName = displayNameFor(data.user.user_metadata, userEmail);

  /* ──────────────────────────────────────────────────────────────────────────
   * Read the existing profile BEFORE the domain decision.
   * supabaseAdmin bypasses RLS; this route is the one place where that is
   * correct pre-authorization, because deciding whether the caller may be
   * authorized at all is exactly what it is doing.
   * ────────────────────────────────────────────────────────────────────────── */
  const { data: existingProfile, error: profileLookupError } = await supabaseAdmin
    .from('profiles')
    .select('id, status, role')
    .eq('id', userId)
    .maybeSingle();

  const existingStatus =
    typeof existingProfile?.status === 'string' ? existingProfile.status : null;

  /* ──────────────────────────────────────────────────────────────────────────
   * GATE 2 — school-domain enforcement.
   * isSchoolEmail is the ONLY definition of the domain rule in TypeScript
   * (lib/env.ts), deliberately bug-compatible with SQL's split_part(addr,'@',2).
   * Do not re-declare the domain list here.
   * ────────────────────────────────────────────────────────────────────────── */
  if (!isSchoolEmail(userEmail)) {
    if (profileLookupError) {
      // We could not read the profile, so we CANNOT know whether this account
      // is the grandfathered admin. Deleting the auth user on a transient
      // database blip would be unrecoverable, so fail closed WITHOUT deleting:
      // drop the session and send them back to /login to try again.
      console.error(
        '[auth/callback] profile lookup failed while checking a non-school address — ' +
          'refusing the sign-in but NOT deleting the account.',
        { userId, message: profileLookupError.message, code: profileLookupError.code }
      );
      await signOutQuietly(supabase, userId);
      return loginError('auth-error', responseHeaders);
    }

    if (existingProfile && existingStatus === 'approved') {
      // ── THE GRANDFATHER CLAUSE ──────────────────────────────────────────
      // An account that an officer already approved keeps its access even
      // though its address is not a school domain. Without this, the club's
      // only admin — whose Google account is a personal address (see STEP 0 of
      // supabase-schema.sql) — is locked out of their own app the moment this
      // rule ships, and the app cannot be recovered without manual SQL.
      // The rule still applies to everyone else: only an ALREADY-APPROVED row
      // passes, so no new non-school account can slip through.
      console.warn(
        '[auth/callback] grandfathered sign-in: non-school address with an ' +
          'already-approved profile. Allowing.',
        { userId, role: existingProfile.role }
      );
    } else {
      // Reject. Order is load-bearing: signOut FIRST so its session-clearing
      // Set-Cookie headers land on responseHeaders and travel with the
      // redirect, THEN delete the auth user.
      console.warn('[auth/callback] rejecting non-school sign-in', {
        userId,
        domain: userEmail.split('@')[1] ?? null,
        hadProfileRow: existingProfile !== null,
        existingStatus,
      });

      await signOutQuietly(supabase, userId);

      // Deleting the auth user (rather than leaving a 'rejected' row behind)
      // means a student who fumbled the account picker can immediately retry
      // with the right account and gets a clean first-time signup. This only
      // works because the SQL gives profiles_id_fkey `on delete cascade`.
      // NON-FATAL: the session is already gone, so a failed delete leaves a
      // dormant auth row, not access. Log it and carry on.
      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteError) {
        console.error(
          '[auth/callback] could not delete the rejected auth user (non-fatal — ' +
            'the session was already cleared):',
          { userId, message: deleteError.message, status: deleteError.status }
        );
      }

      return loginError('domain', responseHeaders);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * GATE 2b — profile creation fallback.
   * The `on auth.users` trigger is unreliable (commit 37e9246 exists because
   * it silently did not fire), so the callback creates the row itself.
   *
   * ██ NEVER WRITE role OR status ON A RETURNING LOGIN. ██
   * An upsert like `.upsert({ id, email, name, role: 'member', status:
   * 'pending' })` looks harmless and is catastrophic: it silently DEMOTES
   * every officer to 'member' and UN-APPROVES every member the next time they
   * sign in. It presents as "the approval system randomly broke" — nobody
   * connects it to a login — so:
   *   • missing row → insert { id, email, name, status } — status decided
   *     ONCE, at creation, by the same domain rule the DB trigger applies
   *     (see the insert below); the column DEFAULT still owns role.
   *   • existing row → update email and name ONLY.
   * Auto-approval (2026-08-12) did NOT change this rule. It is also what
   * makes an officer decline STICK: a 'rejected' row stays rejected on every
   * later sign-in precisely because this path never rewrites status.
   * ────────────────────────────────────────────────────────────────────────── */
  let profileExists = existingProfile !== null && !profileLookupError;

  if (profileLookupError) {
    // Allowed domain, but we cannot tell 'missing' from 'exists'. Writing
    // blind risks clobbering or a spurious sign-out, so write nothing: send
    // them to /pending, which reads its own state and (if they are actually
    // approved) bounces them straight to /. Same direction getSession fails.
    console.error('[auth/callback] profile lookup failed — skipping the profile write.', {
      userId,
      message: profileLookupError.message,
      code: profileLookupError.code,
    });
    return redirectWithCookies(`${SITE_URL}/pending`, responseHeaders);
  }

  if (!profileExists) {
    // No role — the DEFAULT owns that. Status is explicit since auto-approval
    // (2026-08-12): the DB trigger now creates school signups 'approved', but
    // the column default is still 'pending', so this fallback must make the
    // same decision or the two creation paths disagree. isSchoolEmail
    // (lib/env.ts) is the one TypeScript home of the domain rule.
    //
    // The non-school branch is UNREACHABLE: a non-school address without a
    // grandfathered profile was rejected and deleted above, and a
    // grandfathered one HAS a profile row. Written defensively anyway —
    // 'pending' fails closed. NEVER 'approved' here.
    const { error: insertError } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: userId,
        email: userEmail,
        name: userName,
        status: isSchoolEmail(userEmail) ? 'approved' : 'pending',
      });

    if (insertError) {
      if (insertError.code === '23505') {
        // The database trigger won the race between our select and this
        // insert. The row exists and is correct; fall through to the update.
        profileExists = true;
      } else {
        console.error('[auth/callback] could not create the profile row:', {
          userId,
          message: insertError.message,
          code: insertError.code,
        });
        await signOutQuietly(supabase, userId);
        return loginError('auth-error', responseHeaders);
      }
    }
  }

  if (profileExists) {
    // email and name ONLY. See the block comment above.
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ email: userEmail, name: userName })
      .eq('id', userId);

    if (updateError) {
      // Non-fatal: a stale display name is not a reason to block a sign-in.
      console.error('[auth/callback] could not refresh the profile email/name:', {
        userId,
        message: updateError.message,
        code: updateError.code,
      });
    }
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Route on approval status. Anything that is not exactly 'approved' goes to
   * /pending, which owns the copy for each case. Since auto-approval that is
   * mostly 'rejected' accounts and fail-closed DB blips — a school signup is
   * created 'approved', so genuine 'pending' is now the rare case.
   * ────────────────────────────────────────────────────────────────────────── */
  const { data: freshProfile, error: statusError } = await supabaseAdmin
    .from('profiles')
    .select('status')
    .eq('id', userId)
    .maybeSingle();

  if (statusError) {
    console.error('[auth/callback] could not read status back — routing to /pending.', {
      userId,
      message: statusError.message,
      code: statusError.code,
    });
  }

  const status = typeof freshProfile?.status === 'string' ? freshProfile.status : null;

  // An approved user goes where they were headed (a scanned /checkin URL, say),
  // or to the dashboard. A pending or rejected one always goes to /pending —
  // honouring `next` for them would just bounce off requireApproved anyway.
  const destination = status === 'approved' ? (nextPath ?? '/') : '/pending';

  return redirectWithCookies(`${SITE_URL}${destination}`, responseHeaders);
};

/**
 * Clear the session, appending the clearing Set-Cookie headers to the shared
 * responseHeaders. Never throws: if sign-out itself fails there is nothing
 * useful left to do, and on the rejection path deleteUser invalidates the
 * session server-side anyway.
 */
async function signOutQuietly(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  userId: string
): Promise<void> {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error('[auth/callback] signOut returned an error:', {
        userId,
        message: error.message,
        status: error.status,
      });
    }
  } catch (thrown) {
    console.error('[auth/callback] signOut threw:', {
      userId,
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
}
