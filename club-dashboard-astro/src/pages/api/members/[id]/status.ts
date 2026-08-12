import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../../lib/supabase';
import { apiRequireOfficer, apiJson, type MemberStatus } from '../../../../lib/auth';
import { isSchoolEmail } from '../../../../lib/env';

/**
 * PATCH /api/members/:id/status  —  approve or decline a pending account.
 * Body: { status: 'approved' | 'rejected' }
 *
 * Guarded by apiRequireOfficer, i.e. admin OR treasurer — deliberately NOT
 * admin-only. Treasurers run meetings, and letting new members in is part of
 * running a meeting; routing every approval through the one admin is how the
 * queue stops being worked. Role changes are the admin-only verb and live on
 * PATCH /api/members/:id.
 *
 * FOUR REFUSALS, in this order:
 *   1. Self — an officer may not rule on their own account (403). Checked before
 *      any DB work, because it needs no DB work.
 *   2. Missing — no profiles row for that id (404).
 *   3. Domain — approving an email that is not @mittymonarch.com / @mitty.com
 *      (409). Declining one is still allowed: that is how you dispose of a bad
 *      row. isSchoolEmail is imported, never re-implemented — the rule lives in
 *      lib/env.ts and is mirrored by public.is_school_email() in SQL.
 *   4. Last admin — declining the only approved admin (409). Same guard, same
 *      reasoning as the role endpoint: it is the write that locks the club out
 *      of its own approval queue with no recovery short of the Supabase table
 *      editor.
 *
 * Fully reversible by design: an officer can flip a rejected account back to
 * approved through this same endpoint.
 */

const SETTABLE_STATUSES: readonly MemberStatus[] = ['approved', 'rejected'];

/** Postgres check_violation — profiles_status_check, or (if STEP 9 of
 *  supabase-schema.sql was applied) profiles_school_email_check. */
const PG_CHECK_VIOLATION = '23514';

export const PATCH: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireOfficer(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = (params.id ?? '').trim();
  if (!id) {
    return apiJson(400, { error: 'Missing member id' }, responseHeaders);
  }

  // ── REFUSAL 1: no self-approval ───────────────────────────────────────────
  // A pending account cannot reach this endpoint at all (apiRequireOfficer
  // requires approved), so this is not about self-promotion from nothing. It is
  // about an officer quietly un-declining or re-approving themselves without a
  // second person in the loop — approval provenance is worthless if the subject
  // can be the approver.
  if (id === session.id) {
    return apiJson(
      403,
      { error: 'You cannot change your own approval status. Ask another officer.' },
      responseHeaders
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const rawStatus = (body as { status?: unknown } | null)?.status;
  if (typeof rawStatus !== 'string' || !SETTABLE_STATUSES.includes(rawStatus as MemberStatus)) {
    // 'pending' is intentionally not settable here: there is no product reason
    // to push a decided account back into the queue, and allowing it would let
    // an officer erase an approval without leaving a decision on the row.
    return apiJson(400, { error: "status must be 'approved' or 'rejected'" }, responseHeaders);
  }
  const newStatus = rawStatus as MemberStatus;

  // Read the target first: we need its email for the domain check, its role and
  // status for the last-admin check, and a genuine 404 for an unknown id (a
  // bare .update() matching zero rows otherwise reports success).
  const { data: target, error: targetError } = await supabaseAdmin
    .from('profiles')
    .select('id, name, email, role, status')
    .eq('id', id)
    .maybeSingle();

  if (targetError) {
    console.error('[api/members/:id/status] target lookup failed', {
      targetId: id,
      actorId: session.id,
      code: targetError.code,
      message: targetError.message,
    });
    return apiJson(500, { error: 'Could not load that member.' }, responseHeaders);
  }

  // ── REFUSAL 2: no such profile ────────────────────────────────────────────
  if (!target) {
    return apiJson(404, { error: 'Member not found' }, responseHeaders);
  }

  // ── REFUSAL 3: approving a non-school address ─────────────────────────────
  // The callback already deletes non-school signups, so reaching this means
  // either a grandfathered legacy row or an address changed out of band. Either
  // way the roster stays school-only. Declining is deliberately still allowed.
  if (newStatus === 'approved' && !isSchoolEmail(target.email as string | null)) {
    return apiJson(
      409,
      {
        error:
          'That account is not on a school domain, so it cannot be approved. ' +
          'Members must sign in with @mittymonarch.com (students) or @mitty.com (faculty).',
      },
      responseHeaders
    );
  }

  // ── REFUSAL 4: declining the last approved admin ──────────────────────────
  // Only bites when the target is currently in the approved-admin pool; a
  // pending or member-role account is not, so declining one is free.
  if (newStatus === 'rejected' && target.role === 'admin' && target.status === 'approved') {
    const { count, error: countError } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'approved');

    if (countError || count === null) {
      // Fail CLOSED — same posture as the role endpoint. If we cannot prove
      // another admin exists, we do not perform the write that can lock the
      // club out of its own portal.
      console.error('[api/members/:id/status] admin count failed — refusing decline', {
        targetId: id,
        actorId: session.id,
        code: countError?.code,
        message: countError?.message,
      });
      return apiJson(
        503,
        { error: 'Could not verify how many admins remain. Nothing was changed — try again.' },
        responseHeaders
      );
    }

    if (count <= 1) {
      return apiJson(
        409,
        {
          error:
            'This is the last approved admin. Promote someone else to admin first, ' +
            'otherwise nobody can approve members or change roles.',
        },
        responseHeaders
      );
    }
  }
  // Same caveat as PATCH /api/members/:id — count-then-write is not atomic, and
  // the count query is duplicated rather than shared because src/lib is owned
  // by another agent. If a third caller ever needs it, lift it into lib/.

  // approved_by / approved_at record WHO RULED, not only who said yes: a
  // decline is stamped exactly the same way, so "who declined this person and
  // when" is answerable. now() comes from the app server rather than the DB;
  // that is close enough for an audit trail nobody paginates.
  const decidedAt = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ status: newStatus, approved_by: session.id, approved_at: decidedAt })
    .eq('id', id)
    .select('id, name, email, role, status, approved_by, approved_at')
    .single();

  if (error) {
    console.error('[api/members/:id/status] status update failed', {
      targetId: id,
      actorId: session.id,
      newStatus,
      code: error.code,
      message: error.message,
    });

    if (error.code === PG_CHECK_VIOLATION) {
      return apiJson(
        409,
        {
          error:
            'The database rejected that change. Check that the account uses a school ' +
            'email address (@mittymonarch.com or @mitty.com).',
        },
        responseHeaders
      );
    }

    // Never echo the raw Postgres message to the client. If `status`,
    // `approved_by` or `approved_at` do not exist yet, supabase-schema.sql has
    // not been applied — the code is in the Vercel function log.
    return apiJson(500, { error: "Could not update that member's status." }, responseHeaders);
  }

  console.info('[api/members/:id/status] status changed', {
    targetId: id,
    actorId: session.id,
    from: target.status,
    to: newStatus,
  });

  return apiJson(200, { data }, responseHeaders);
};
