import type { APIRoute } from 'astro';
import { apiRequireOfficer, apiJson } from '../../../lib/auth';
import { findOrCreateMember, parseEmailList, type ParsedEntry } from '../../../lib/member-invite';

/**
 * POST /api/members/invite — officer-only. Pre-register people by email.
 *
 * WHY THIS EXISTS
 *   At the club fair people wrote their emails on paper instead of signing in.
 *   This puts them on the roster immediately, with a real account waiting.
 *
 * How the account is made — and why that is not a login bypass, why
 * `email_confirm` is load-bearing, and why only school domains — lives with
 * the shared code in src/lib/member-invite.ts (POST /api/attendance/manual
 * creates accounts the same way).
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

  const parsed = parseEmailList(body.text, MAX_ENTRIES);
  if (!parsed.ok) return apiJson(400, { error: parsed.error }, responseHeaders);

  const results: Result[] = parsed.rejected.map((r) => ({ email: r.email, outcome: 'rejected', reason: r.reason }));

  async function invite(entry: ParsedEntry): Promise<Result> {
    const member = await findOrCreateMember(entry, session.id, 'api/members/invite');
    switch (member.outcome) {
      case 'existing':
      case 'auth-only':
        return { email: entry.email, outcome: 'already' };
      case 'created':
        return { email: entry.email, outcome: 'created', name: member.name };
      case 'error':
        return { email: entry.email, outcome: 'rejected', reason: member.reason };
    }
  }

  for (let i = 0; i < parsed.entries.length; i += CONCURRENCY) {
    const batch = parsed.entries.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map(invite))));
  }

  const summary = {
    created: results.filter((r) => r.outcome === 'created').length,
    already: results.filter((r) => r.outcome === 'already').length,
    rejected: results.filter((r) => r.outcome === 'rejected').length,
  };

  return apiJson(200, { summary, results }, responseHeaders);
};
