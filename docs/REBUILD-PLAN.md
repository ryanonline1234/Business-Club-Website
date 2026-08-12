# Rebuild Plan

The Mitty Business Club portal is being rebuilt on branch `rebuild/mbc-portal`.
This is the spec. The machine-readable version — including per-page data shapes —
is [`rebuild-plan.json`](rebuild-plan.json).

**Status:** code-complete on `rebuild/mbc-portal` — teardown, backend (auth
foundation, guards, endpoints), all pages in the approved "Warm & Mobile-First"
design, and the doc rewrite (the [Documentation debt](#documentation-debt)
below is paid). Remaining: apply the migration (STEP 0 pre-flight first), deploy,
and the SITE_URL + Supabase allow-list cutover — see
[DEPLOYMENT.md](DEPLOYMENT.md#deploy-order-sql-first-then-code).

---

## Decisions

Settled with the repo owner before any code changed:

| Decision | Choice |
|---|---|
| Scope | New site — every page and the whole design rewritten from scratch. Keep the Supabase schema, the Google OAuth flow, and the Vercel build config, which encode 8 commits of OAuth debugging. |
| Legacy Next.js app | **Deleted.** It was never deployed; `vercel.json` always skipped it. |
| Finance / treasury | **Cut from the UI** — page, endpoints, and nav entry. The `transactions` / `budgets` / `categories` **tables stay in the database**, untouched. Reversible on purpose: re-enabling treasury later is a page, not a migration. |
| Features | Announcements, member roster, QR-code attendance, event scheduling. |
| Who can sign in | School Google domains only — `@mittymonarch.com` (students), `@mitty.com` (faculty/adults) — **and** an officer must approve each new account before it sees anything. |
| Deploy target | Vercel project `mitty-business-club`, production alias `mittybusinessclub.vercel.app`. |

---

## Teardown (done)

60 files removed:

- **Legacy Next.js app**: root `src/`, `public/`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `package.json`, `package-lock.json`, `tsconfig.json`.
- **Finance module**: `club-dashboard-astro/src/pages/finance.astro`, `src/pages/api/finance/**`, and the Finance nav entry in `Sidebar.astro`.
- **Dead read endpoints**: `api/events/index.ts`, `api/announcements/index.ts`, `api/attendance/index.ts`, `api/members/index.ts` — all unused by any page, two of them fully unauthenticated, and the members one was the source of the profile UUIDs that made the check-in impersonation hole exploitable.

`cd club-dashboard-astro && npm run build` passes with all of it gone.

There is no root `package.json` any more. `vercel.json` sets `framework: null` and a
no-op `installCommand`, so in principle nothing at the root is required — **but this
has never been tested with the root manifest actually absent.** Verify on a preview
deployment before merging to `main`; be ready to leave a two-line stub if the Vercel
build container complains.

---

## Access control

Four gates. Gate 1 is a hint; 2–4 are enforcement.

1. **Google account chooser** — `hd: '*'` on `signInWithOAuth` so Google hides personal accounts. Client-controllable, never trusted, re-verified in gate 2.
2. **Domain check in the OAuth callback** — reject anything outside the two school domains, *after* the grandfather check below. On reject: `signOut()` first so the session cookie is cleared, then `admin.deleteUser()`, then redirect to `/login?error=domain`. Deleting rather than leaving a `rejected` row means a student who picked the wrong account can just retry.
3. **Session layer** (`lib/auth.ts`) — `requireSession` / `requireApproved` / `requireOfficer` for pages, `apiRequireApproved` / `apiRequireOfficer` / `apiRequireAdmin` for endpoints. Every route starts with one of these. No hand-rolled role checks — copy-pasted checks are exactly how two endpoints ended up unauthenticated.
4. **Page level** — the only public routes are `/login`, `/pending`, `/checkin`, and `/api/auth/*`.

**Approval flow:** new school-domain accounts land on `/pending`. Officers (admin *or* treasurer — treasurers run meetings, so this is deliberately not admin-only) see a pending queue above the roster and approve or decline via `PATCH /api/members/[id]/status`. Reversible in both directions.

### Two ways this locks you out — both guarded

**A grandfathered non-school admin.** The git author email on this repo is a
`gmail.com` address. If the only admin signs in with a personal account, a naive
domain check destroys their session *and deletes their profile row via the new
cascade*. Mitigations, both required:

- Run **STEP 0** of the migration and read the result before anything else.
- Implement the **grandfather clause**: an existing profile with `status = 'approved'` signs in regardless of domain.
- **Do not add the STEP 9 constraint if STEP 0 returns any rows.**

**A returning-login upsert.** The tempting one-liner —
`upsert({ id, email, name, role: 'member', status: 'pending' })` — resets role and
status on *every* sign-in. Officers silently become members; approved members
silently become pending; it presents as the approval system randomly un-approving
people. Insert-if-missing writes only `id`/`email`/`name` and lets column defaults
do the rest. Update-if-present touches `email` and `name` **only, ever.**

---

## Migration

Full SQL in [`rebuild-plan.json`](rebuild-plan.json) under `schema_changes` — 16 steps.
The shape that matters:

```sql
-- STEP 0   pre-flight: who is on a non-school domain today? READ THIS FIRST.
-- STEP 1   add `status text` with NO default        → existing rows go NULL
-- STEP 2   backfill NULL → 'approved'               → today's members keep access
-- STEP 3   set default 'pending', then NOT NULL     → only new signups are pending
-- STEP 4   check constraint (pending|approved|rejected)
-- STEP 5   approved_by / approved_at provenance
-- STEP 6   indexes, incl. a partial index for the pending queue
-- STEP 7   profiles.id → auth.users ON DELETE CASCADE (deleteUser needs it)
-- STEP 8   is_school_email(text) helper
-- STEP 9   OPTIONAL domain constraint — only if STEP 0 was empty
-- STEP 10  rewrite handle_new_user (writes status, on conflict do nothing)
-- STEP 11  recreate trigger idempotently (the old one errored on re-run)
-- STEP 12  is_approved() / is_officer() / is_admin() security-definer helpers
-- STEP 13  approval-aware RLS on profiles (treasurers could never read profiles before)
-- STEP 14  approval-aware RLS on events / announcements / attendance
-- STEP 15  verification queries
```

> **Steps 1–3 are three statements for a reason.** Writing
> `add column status text not null default 'pending'` as one statement instantly
> flips every existing member — including every officer — to pending. The roster
> empties, the approval queue fills with people who were already approved, and
> nobody with the power to fix it can log in. Skipping the middle step is a
> self-inflicted lockout.

**Deploy order: SQL first, then code.** Backwards is unrecoverable — if the build
ships before the column exists, every `select … status` errors, `getSession` fails
closed by design, and 100% of users land on `/pending` with no way out. SQL-first
is safe: applied against the old code it just means new signups carry a `status`
the old app ignores.

---

## Security fixes

15 issues found reading the current source. Full detail in
[`rebuild-plan.json`](rebuild-plan.json) under `security_fixes`.

### Must fix

| # | Where | Issue |
|---|---|---|
| 1 | `api/attendance/checkin.ts` | `member_id` read from the POST body with no authorization — anyone with a QR token writes attendance for any member. Endpoint is fully public. |
| 2 | `api/events/[id]/qr.ts` | No auth at all; anyone knowing an event UUID mints a valid 4-hour check-in token. Combined with #1 this is an unauthenticated write path into `attendance`. |
| 6 | `announcements.astro` | Stored XSS — `innerHTML` with unescaped DB strings. Since role changes are admin-only, a treasurer can script their way to admin in an admin's browser. Privilege escalation, not defacement. |
| 7 | `calendar.astro` | Same class — event titles interpolated into an HTML **attribute**, so a title with a double quote breaks out. |
| 8 | `lib/qrcode.ts` | **`AUTH_SECRET` unset → `jose` signs HS256 with an empty key and does not throw** (verified against the installed `jose`, not assumed). Every check-in token forgeable, nothing looks wrong. Nothing validates env at boot. |
| 5 | `lib/auth.ts` | `getSession` fails **open** — a missing profile row yields a valid `member` session. With approval state that becomes access no officer ever granted. |

### Also fixing

- **#9 last-admin lockout** — no guard against demoting or declining the only admin. Recovery is a manual `UPDATE` in the Supabase table editor, which is what the approval flow was supposed to eliminate.
- **#12** — raw Supabase error text is URL-encoded into a redirect, putting provider internals in browser history and referrer headers.
- **#13** — `events.password` is stored in plaintext for a flow that was never built and nothing reads. Stop writing it; leave the column (same reversible posture as the finance tables).
- **#14** — no CSRF defence beyond `SameSite=lax`. Add an `Origin` check to the shared `apiRequire*` helpers: one check, every endpoint.
- **#15** — RLS policies are enabled but inert (everything runs as service role), and they no longer describe reality. Rewritten on `is_approved()` / `is_officer()` / `is_admin()` so they stop being a lie and become a real second line of defence.

### Hardening the QR token

Cut the lifetime from 4 hours to 15 minutes with silent re-fetch while the modal
is open, pin `algorithms: ['HS256']` plus issuer/audience/`jti` on verify, and
gate minting to officers. This shrinks the blast radius but does not eliminate it:
**anyone in the room who photographs the projected code can still check in**, and
can forward it to an absent friend. That is an accepted trade for a club
dashboard — the point is not to let the security work imply it was solved.

---

## Other bugs to fix in passing

- **Calendar date bucketing is wrong.** `start_time.split('T')[0]` is the *UTC* date, and rendering does `new Date('YYYY-MM-DD')` (UTC midnight). For a Pacific-time club any event after 4–5pm local renders on the following day. Compute local date keys explicitly.
- **`budgets.spent` is never updated** — moot for now since the finance UI is cut, but the column is still a lie if treasury ever comes back. Derive it at read time rather than maintaining a counter.
- **Hardcoded term label** — `DashboardLayout.astro` defaults its subtitle to `'Spring 2026 · Officer View'`.

---

## SITE_URL cutover

`SITE_URL` on Vercel is currently `https://mitty-business-club.vercel.app`, which
returns `DEPLOYMENT_NOT_FOUND`. Production is served at
`https://mittybusinessclub.vercel.app`. Since `SITE_URL` drives the login
redirect, the OAuth callback, and sign-out, sign-in is currently dead in
production.

Three things have to move together:

1. **Vercel** → `SITE_URL` = `https://mittybusinessclub.vercel.app`.
2. **Supabase** → Auth → URL Configuration gains `https://mittybusinessclub.vercel.app/api/auth/callback`, and Site URL should match. **If this is skipped the OAuth redirect silently bounces to the dead host and every sign-in fails with an opaque error.**
3. **Google Cloud Console** → **unchanged.** Its redirect URI is Supabase's own `https://<project-ref>.supabase.co/auth/v1/callback`. That asymmetry is the classic way to break sign-in while "fixing" the domain.

**Every outstanding QR code dies on cutover.** Check-in URLs embed `SITE_URL`, so
anything printed, projected, or saved in a slide deck points at the dead host. The
tokens stay signature-valid; the hostname inside them does not. Regenerate from the
events page afterward and tell officers to re-project.

---

## Documentation debt

The five docs in this directory describe the app **as of the pre-rebuild state**.
`API.md` and `KNOWN-GAPS.md` in particular reference finance endpoints that no
longer exist. They need rewriting in the same change that lands the rebuild —
along with `README.md` (still documents pre-rebuild routes) and `AGENTS.md`
(already updated to drop the Next.js block).
