import type { APIRoute } from 'astro';
import { supabaseAdmin } from '../../../lib/supabase';
import { apiRequireAdmin, apiJson, type MemberRole } from '../../../lib/auth';

/**
 * PATCH /api/members/:id  —  change a member's ROLE. Admin only.
 *
 * Approval status is a different verb on a different route:
 * PATCH /api/members/:id/status, which officers (admin OR treasurer) may call.
 * Role promotion stays admin-only; a treasurer cannot mint another admin.
 *
 * THE LAST-ADMIN GUARD is the reason most of this file exists. If the only
 * approved admin is demoted, nobody can promote anyone or approve anyone ever
 * again, and the only way out is hand-editing a row in the Supabase table
 * editor — precisely the manual step the approval flow is supposed to delete.
 * So a write that would take the approved-admin count to zero is refused 409.
 *
 * Note what is NOT guarded: an admin demoting themselves. That is allowed as
 * long as another approved admin remains, which is the normal "I'm graduating,
 * hand it over" path. The last-admin count already covers the lockout case, and
 * blocking self-demotion outright would mean the outgoing admin needs someone
 * else to do it for them.
 */

const ROLES: readonly MemberRole[] = ['member', 'treasurer', 'admin'];

/** Postgres check_violation. Fired by profiles_status_check and, if STEP 9 of
 *  supabase-schema.sql was applied, by profiles_school_email_check when any
 *  UPDATE touches a grandfathered row on a non-school domain. */
const PG_CHECK_VIOLATION = '23514';

export const PATCH: APIRoute = async ({ request, params }) => {
  const responseHeaders = new Headers();
  const guard = await apiRequireAdmin(request, responseHeaders);
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const id = (params.id ?? '').trim();
  if (!id) {
    return apiJson(400, { error: 'Missing member id' }, responseHeaders);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiJson(400, { error: 'Invalid JSON' }, responseHeaders);
  }

  const rawRole = (body as { role?: unknown } | null)?.role;
  if (typeof rawRole !== 'string' || !ROLES.includes(rawRole as MemberRole)) {
    return apiJson(
      400,
      { error: 'role must be admin, treasurer, or member' },
      responseHeaders
    );
  }
  const newRole = rawRole as MemberRole;

  // Read the target BEFORE writing: we need its current role and status to know
  // whether this write is the one that empties the admin bench, and we need a
  // real 404 for an id that does not exist (a bare .update() on a missing row
  // succeeds with zero rows affected and looks like success).
  const { data: target, error: targetError } = await supabaseAdmin
    .from('profiles')
    .select('id, name, email, role, status')
    .eq('id', id)
    .maybeSingle();

  if (targetError) {
    console.error('[api/members/:id] target lookup failed', {
      targetId: id,
      actorId: session.id,
      code: targetError.code,
      message: targetError.message,
    });
    return apiJson(500, { error: 'Could not load that member.' }, responseHeaders);
  }

  if (!target) {
    return apiJson(404, { error: 'Member not found' }, responseHeaders);
  }

  if (target.role === newRole) {
    // Idempotent no-op. Skipping the write also skips the check constraints,
    // so re-saving an unchanged role on a grandfathered row cannot 409.
    return apiJson(200, { data: target }, responseHeaders);
  }

  // ── LAST-ADMIN GUARD ──────────────────────────────────────────────────────
  // Only relevant when this write removes an *approved admin* from the pool.
  // A pending or rejected admin is not in the pool, so demoting one is free.
  if (newRole !== 'admin' && target.role === 'admin' && target.status === 'approved') {
    const { count, error: countError } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'approved');

    if (countError || count === null) {
      // Fail CLOSED. If we cannot prove another admin exists, we do not perform
      // the one write that can lock everyone out of the club's own portal.
      console.error('[api/members/:id] admin count failed — refusing demotion', {
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
  // NOTE: count-then-write is not atomic. Two admins demoting each other in the
  // same instant could both pass this check. There is no transaction available
  // through PostgREST here; a DB-level guard would be the real fix. For a club
  // with a handful of officers clicking buttons, the window is not worth a
  // migration — but do not read this guard as an airtight invariant.

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ role: newRole })
    .eq('id', id)
    .select('id, name, email, role, status')
    .single();

  if (error) {
    console.error('[api/members/:id] role update failed', {
      targetId: id,
      actorId: session.id,
      newRole,
      code: error.code,
      message: error.message,
    });

    if (error.code === PG_CHECK_VIOLATION) {
      return apiJson(
        409,
        {
          error:
            "This account's email is not on a school domain, so the database " +
            'refuses to update it. Their address must be @mittymonarch.com or @mitty.com.',
        },
        responseHeaders
      );
    }

    // Never echo the raw Postgres message to the client.
    return apiJson(500, { error: 'Could not update that member.' }, responseHeaders);
  }

  console.info('[api/members/:id] role changed', {
    targetId: id,
    actorId: session.id,
    from: target.role,
    to: newRole,
  });

  return apiJson(200, { data }, responseHeaders);
};
