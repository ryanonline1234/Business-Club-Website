import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiRequireOfficer, apiJson } from '../../../lib/auth';
import { isSchoolEmail } from '../../../lib/env';

/**
 * POST /api/members/invite — officer-only. Pre-register people by email.
 *
 * WHY THIS EXISTS
 *   At the club fair people wrote their emails on paper instead of signing in.
 *   This puts them on the roster immediately, with a real account waiting.
 *
 * WHAT IT IS NOT: a login bypass. Google OAuth is the only credential path and
 * this does not change that. What it buys is that when the person DOES sign in
 * with Google, Supabase's automatic identity linking matches the verified email
 * to the user created here and attaches the Google identity to it — same user
 * id, so api/auth/callback (which looks a profile up by id) finds THIS row and
 * merely refreshes name/email. Their role, status and history survive.
 *
 * `email_confirm: true` is load-bearing, not a convenience: Supabase refuses to
 * auto-link an identity to an UNVERIFIED email, because that is the classic
 * pre-account-takeover attack. Without it, a pre-registered person signing in
 * would not get this row.
 *
 * Marking the address confirmed is safe HERE specifically because the account
 * we create has NO PASSWORD. (Measured, not assumed: Supabase does attach one
 * confirmed `email` identity to an admin-created user — it is not identity-less.
 * That identity carries no password, so the only ways to reach the account are
 * Google sign-in or an email OTP to that inbox. Both require the real owner.)
 * There is no credential here for anyone else to take over.
 *
 * SCHOOL DOMAINS ONLY, AND NOT FOR TIDINESS
 *   api/auth/callback grandfathers any existing profile with status 'approved'
 *   past the domain gate (that clause exists so the founding admin on a
 *   personal address is not locked out). So an officer pre-registering
 *   someone@gmail.com as approved would manufacture a permanent, working
 *   backdoor around the domain restriction. isSchoolEmail() closes it.
 */

/** Hard cap per request. A club-fair sheet is tens of names, not thousands. */
const MAX_ENTRIES = 200;
/** How many auth-user creations to run at once. Modest: this is a write path. */
const CONCURRENCY = 4;

type Outcome = 'created' | 'already' | 'rejected';
interface Result {
  email: string;
  outcome: Outcome;
  /** Present on 'rejected'; human-readable and safe to render. */
  reason?: string;
  /** Present on 'created'. */
  name?: string;
}

interface ParsedEntry {
  email: string;
  /** Name the officer typed, if any. Beats anything we derive. */
  givenName: string | null;
  raw: string;
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

/**
 * Pull one entry out of a pasted line. Officers paste whatever their notes
 * look like, so accept the shapes a paper list actually turns into:
 *   ava.chen28@mittymonarch.com
 *   Ava Chen <ava.chen28@mittymonarch.com>
 *   Ava Chen, ava.chen28@mittymonarch.com
 *   ava.chen28@mittymonarch.com — Ava Chen
 * Returns null for a line with no email-shaped token at all (blank lines,
 * headings like "SIGN-UPS 9/12", stray notes).
 */
function parseLine(line: string): ParsedEntry | null {
  const raw = line.trim();
  if (!raw) return null;

  // Angle-bracket form first — it is unambiguous.
  const angled = raw.match(/^(.*?)<\s*([^<>\s]+)\s*>$/);
  if (angled && EMAIL_RE.test(angled[2])) {
    const name = angled[1].replace(/[,;–—-]+\s*$/, '').trim();
    return { email: angled[2], givenName: name || null, raw };
  }

  // Otherwise: find the email-shaped token, treat the rest of the line as name.
  const tokens = raw.split(/[\s,;]+/).filter(Boolean);
  const emailToken = tokens.find((t) => EMAIL_RE.test(t));
  if (!emailToken) return null;

  const rest = tokens
    .filter((t) => t !== emailToken)
    .join(' ')
    .replace(/^[–—:-]+|[–—:,-]+$/g, '')
    .trim();

  return { email: emailToken, givenName: rest || null, raw };
}

/**
 * Best-effort display name from a school address.
 *
 * Student addresses are firstname + lastname + last two digits of grad year,
 * e.g. ryantseng29@mittymonarch.com. That format yields the GRAD YEAR reliably.
 * It does NOT yield a first/last split: "ryantseng" is equally "Ryan Tseng" and
 * "Ryant Seng", and nothing in the string says which. So we do not guess —
 * separators are honoured when present, and otherwise the run of letters is
 * capitalised as one word.
 *
 * This only has to survive until their first sign-in, when api/auth/callback
 * overwrites `name` with the real one from Google.
 */
function deriveName(email: string): { name: string; gradYear: number | null } {
  const local = email.split('@')[0] ?? '';
  const m = local.match(/^(.*?)(\d{2})$/);
  const stem = (m ? m[1] : local).replace(/[._-]+/g, ' ').trim();
  const yy = m ? Number(m[2]) : null;

  const name =
    stem
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ') || local;

  // '29 → 2029. Two digits are ambiguous across centuries; a high-school roster
  // is unambiguous in practice, so map into the current century.
  const gradYear = yy === null ? null : 2000 + yy;
  return { name, gradYear };
}

export const POST: APIRoute = async ({ request }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  if (typeof body.text !== 'string') {
    return apiJson(400, { error: 'Paste a list of emails.' }, responseHeaders);
  }
  if (body.text.length > 50_000) {
    return apiJson(400, { error: 'That list is too long. Paste it in smaller batches.' }, responseHeaders);
  }

  // Parse, then de-duplicate within the paste itself (a sheet copied twice is
  // the normal case, not an edge case).
  const seen = new Set<string>();
  const entries: ParsedEntry[] = [];
  const results: Result[] = [];

  for (const line of body.text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    const email = parsed.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);

    if (!EMAIL_RE.test(email)) {
      results.push({ email, outcome: 'rejected', reason: "That doesn't look like an email address." });
      continue;
    }
    if (!isSchoolEmail(email)) {
      results.push({
        email,
        outcome: 'rejected',
        reason: 'Not a school address — only @mittymonarch.com and @mitty.com can be added.',
      });
      continue;
    }
    entries.push({ ...parsed, email });
  }

  if (entries.length === 0 && results.length === 0) {
    return apiJson(400, { error: 'No email addresses found in that text.' }, responseHeaders);
  }
  if (entries.length > MAX_ENTRIES) {
    return apiJson(
      400,
      { error: `That's ${entries.length} addresses. Add at most ${MAX_ENTRIES} at a time.` },
      responseHeaders
    );
  }

  async function invite(entry: ParsedEntry): Promise<Result> {
    const { email } = entry;
    const derived = deriveName(email);
    const name = entry.givenName ?? derived.name;

    // Does a profile already exist? If so we touch NOTHING — an existing member
    // keeps their name, role, status and history. Re-pasting last week's sheet
    // must be a no-op, not a reset.
    const existing = await supabaseAdmin
      .from('profiles')
      .select('id, name')
      .eq('email', email)
      .maybeSingle();

    if (existing.error) {
      console.error('[api/members/invite] profile lookup failed', {
        email,
        code: existing.error.code,
        message: existing.error.message,
      });
      return { email, outcome: 'rejected', reason: 'Could not check the roster. Try again.' };
    }
    if (existing.data) return { email, outcome: 'already' };

    const created = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: name, invited_by_officer: true },
    });

    if (created.error) {
      // An auth user can exist without a profiles row (a signup whose trigger
      // did not fire). That is "already here", not a failure.
      const msg = created.error.message ?? '';
      if (created.error.status === 422 || /already/i.test(msg)) {
        return { email, outcome: 'already' };
      }
      console.error('[api/members/invite] createUser failed', {
        email,
        status: created.error.status,
        message: msg,
      });
      return { email, outcome: 'rejected', reason: 'Could not create that account. Try again.' };
    }

    const userId = created.data.user?.id;
    if (!userId) return { email, outcome: 'rejected', reason: 'Could not create that account. Try again.' };

    // The on_auth_user_created trigger should have made the profile (status
    // derived from the school domain => 'approved'). It has been unreliable
    // before — hence the same belt-and-braces fallback api/auth/callback uses.
    // Insert writes only id/email/name; column defaults own role and status.
    const profile = await supabaseAdmin
      .from('profiles')
      .upsert({ id: userId, email, name }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id')
      .maybeSingle();

    if (profile.error) {
      console.error('[api/members/invite] profile insert failed after createUser', {
        email,
        code: profile.error.code,
        message: profile.error.message,
      });
      // The auth user exists; they can still sign in and the callback will
      // create the profile. Report success rather than implying nothing happened.
    }

    // The trigger may have written the email local part as the name. If the
    // officer typed a real name, prefer it — name only, never role or status.
    if (entry.givenName) {
      await supabaseAdmin.from('profiles').update({ name: entry.givenName }).eq('id', userId);
    }

    console.info('[api/members/invite] pre-registered', {
      email,
      actorId: session.id,
      gradYear: derived.gradYear,
    });
    return { email, outcome: 'created', name };
  }

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(invite))));
  }

  const summary = {
    created: results.filter((r) => r.outcome === 'created').length,
    already: results.filter((r) => r.outcome === 'already').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
  };

  return apiJson(200, { summary, results }, responseHeaders);
};
