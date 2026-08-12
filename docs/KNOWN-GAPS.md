# Known Gaps

Things that are open, accepted, or half-built — written down so nobody
rediscovers them the hard way, and so the security work above doesn't imply
the problems are solved. Severity is a judgement call for a high-school club
portal, not a generic risk rating.

The rebuild closed most of the old list; [what it fixed](#what-the-rebuild-fixed)
is at the bottom for the record.

---

## Operational — the ones that bite next

### Deployed — but `rebuild/mbc-portal` is not merged to `main`

The rebuild is **live** at `https://mittybusinessclub.vercel.app`. The
migration was applied, `SITE_URL` was cut over, and the branch is pushed. What
is still open:

- **The branch has not been merged to `main`.** Vercel's git integration builds
  `main`, so a push to `main` today would deploy the *pre-rebuild* app over the
  top of the current deployment. Merge before anyone pushes to `main`.
- **Verified applied**: `status`, `approved_by`, `approved_at`,
  `is_school_email()`, `is_approved/is_officer/is_admin()`, and the RLS rewrite
  (proved via an anon read of `categories` returning 0 of 4 rows). **Not
  verifiable from outside**: STEP 6 indexes, STEP 7's `on delete cascade`, the
  STEP 10–11 trigger, STEP 13b. STEP 7 is the one worth confirming by hand — a
  rejected non-school signup leaves an orphan profile row without it.

### Local dev and production share one database

No local Supabase, no seed script — `npm run dev` points at whatever project
`.env` names, so **every local experiment mutates real club data**. This is now
sharper than it looks on paper: the app is live and officers may be using it.
Stand up a second Supabase project before the next stretch of feature work.

### No tests, no CI, no lint — and the last two bugs prove the cost

No suite, no runner, no Actions. Both production failures found after deploy
were things a smoke test would have caught in seconds: every mutating request
with no content-type returning 403, and a malformed session cookie 500ing
`/login`. The guard layer, the migration's lockout guards, and the CSRF path
are exactly what deserves tests.

### `SITE_URL` and preview deployments

A single static origin. The CSRF origin check deliberately also accepts the
request's own origin, so API mutations work on previews — but OAuth
`redirectTo` uses `SITE_URL`, so sign-in from a preview lands on whatever
origin `SITE_URL` names. Accepted for now; per-environment `SITE_URL` values
are the fix if preview auth ever matters.

---

## Security — accepted trades, still true

### The QR token is a shared bearer secret

**Severity: medium, accepted.** The projected QR encodes a signed token that
is valid for anyone who holds it: a member in the room can photograph it and
forward it to an absent friend, who checks in from anywhere. The rebuild cut
the blast radius (15-minute TTL, officer-only minting, session-only identity,
event-window checks, `jti` in the logs) but did **not** eliminate it — that
would take per-member tokens or proximity proof, which is over-engineering
for a club meeting. Do not lengthen the TTL to make projection more
convenient; the auto-refresh in Present mode exists so the short window costs
nothing.

### The last-admin guard is not atomic

**Severity: low.** Both member endpoints count approved admins and then
write; two admins demoting/declining each other in the same instant could
both pass the count. There is no transaction available through PostgREST — a
DB-level constraint would be the real fix. For a club with a handful of
officers clicking buttons, the window is not worth a migration. Do not read
the guard as an airtight invariant; it exists to stop the *ordinary* lockout.

### The grandfathered admin vs STEP 9

**Severity: structural.** The club's only admin signs in with a personal
(non-school) address and keeps access through the grandfather clause in the
OAuth callback. Consequences: the DB-level domain constraint (STEP 9) must
never be applied while that row exists, and the domain rule for that account
is enforced in exactly one code path. If the admin ever moves to a school
account, apply STEP 9 and delete this entry.

### Service role is the only database identity

**Severity: structural — by design, but know what it costs.** Every query
runs through `supabaseAdmin`, which bypasses RLS. The rebuilt policies are
truthful and approval-aware, but they gate nothing the app does — **the guard
at the top of each route is the only access control on the hot path.** Forget
the guard in a new endpoint and there is no second line of defence. This is
why `lib/auth.ts` is the only place checks may live.

### One guard ignores the student preview — on purpose

**Severity: low today, sharp if it spreads.** `apiRequireActualOfficer_previewToggleOnly`
in `lib/auth.ts` is the single guard that a previewing officer still passes: it
checks `actualIsOfficer`, the real profiles role, which the "view as student"
preview never downgrades. Every other role guard checks the effective role and
therefore fails closed while previewing.

It exists because `apiRequireOfficer` cannot guard the preview toggle. With the
preview on, `isOfficer` is false, so `apiRequireOfficer` would 403 the exact
request that turns the preview OFF and strand the officer in student view with
no way back but hand-clearing an HttpOnly cookie.

**`POST /api/preview` is its only legitimate caller.** Using it on any other
endpoint silently un-does the preview for that route — the build passes, the
route works, and the officer keeps a privilege they believe they dropped. That
is a review failure, not a runtime one; nothing catches it. The `_previewToggleOnly`
suffix is deliberately ugly so it cannot be picked out of autocomplete beside
`apiRequireOfficer` without noticing. If a second legitimate caller ever appears,
argue it here first.

---

## Half-built and dead-column inventory

Schema features with no code behind them. All inherited; none regressed.

| What | State |
|---|---|
| `events.password` | Dead column. The create endpoint silently ignores a `password` key; nothing reads it. Kept because dropping a column is irreversible. If password check-in is ever built, hash it |
| `events.capacity` | Validated positive on create and displayed on the calendar, but check-in never compares attendance against it |
| `events.status = 'completed'` | Allowed by the check constraint, set by nothing. Events are `active` until cancelled |
| `attendance.qr_data` | Never written |
| `attendance.method = 'password'` | Allowed value, unreachable — the only writer hardcodes `'qr'` |
| `audit_logs` | Full table + officer read policy, zero writes. Role changes and approvals log to the Vercel function log (`console.info` with actor/target ids) instead — ephemeral, but currently the only trail |
| Finance tables (`categories`, `transactions`, `budgets`) | Retained, read by nothing, UI cut. Re-enabling treasury is a page, not a migration. `budgets.spent` is still a lie (never incremented) if that day comes — derive it at read time |

---

## Smaller code truths

### Check-in window constants are duplicated

`start − 30 min / end + 2 h / 4 h assumed length` live in both
`api/attendance/checkin.ts` and `api/events/[id]/qr.ts` (which mirrors them
so it won't mint a code every scan of which would be rejected). They could
not share a module during the rebuild because `src/lib` was owned by another
work stream. If they ever drift, check-in gets confusing at the edges — lift
them into `lib/` on the next touch of either file.


### `GET /api/auth/signout` still exists

The UI signs out via POST forms, but GET is still exported for direct
navigation and old links, hardened by `checkSafeNavigation` (Sec-Fetch-Site
catches the `<img src>` trick that carries no Origin header). Removing GET is
fine once nothing links it; keep the check if it stays.

### No pagination anywhere

`/announcements` renders the latest 50; the officer attendance log fetches
the latest 400 and says so when capped; the roster and calendar load
everything. Fine at club scale; the first thing to revisit if any table grows
past a few hundred rows.

### Mutations reload the whole page

Every client script does `location.reload()` after a successful fetch.
Deliberate — the pages are server-rendered and the reload re-runs the
frontmatter — but it's the pattern to replace first if interactions get
heavier.

### `announcements.author_name` goes stale

Denormalised snapshot taken at post time; survives author deletion, keeps the
old name after a rename. The byline's *role* tag, by contrast, is looked up
live. Deliberate, just know it.

---

## What the rebuild fixed

For the record — these were the old KNOWN-GAPS and security-fix list, all
closed on `rebuild/mbc-portal`:

| Old gap | Fix |
|---|---|
| Check-in impersonation (`member_id` from the body, endpoint public) | Identity is always the session; endpoint requires an approved session; `member_id` in a body is logged as a probe |
| Unauthenticated QR minting (`GET /api/events/:id/qr`) | Officer-gated, `no-store`, refuses closed/cancelled events |
| Unauthenticated read endpoints (`/api/events`, `/api/announcements`) | Deleted outright, with the other unused list endpoints |
| Stored XSS via `innerHTML` on announcements/calendar (treasurer→admin escalation) | All rendering is server-side and escaped; client JS never builds HTML from data |
| `getSession` failed **open** (missing profile → valid member session) | Fails closed to `pending`; `profileState` distinguishes blip from decision |
| Empty `AUTH_SECRET` silently signed forgeable tokens | Boot-time env validation refuses to start |
| Supabase error text leaked into redirect URLs (`&detail=`) | Fixed error-code set; detail only in the function log |
| No CSRF defence beyond `SameSite=lax` | Origin/Sec-Fetch-Site check in the shared guards; signout GET covered too |
| No last-admin guard | Both member endpoints refuse the write that empties the admin bench (with the atomicity caveat above) |
| 4-hour bearer QR tokens | 15 minutes + pinned algorithm/issuer/audience + auto-refresh |
| Calendar bucketed days on UTC (evening events on the wrong day) | Pacific-local day keys everywhere |
| Attendance log shown club-wide to every member | Members see only their own history; emails render officer-only |
| Hardcoded "Spring 2026" term label | Derived from the Pacific date |
| RLS policies stale and recursion-prone; treasurers couldn't read profiles | Rewritten on security-definer helpers, approval-aware, plus the role-change guard trigger |
| The dead Next.js app at the repo root | Deleted (60 files); `vercel.json` posture unchanged |

### A malformed session cookie used to 500 every route

**Fixed, recorded because the failure mode was invisible.** `@supabase/ssr`
stores the session as `base64-<b64>` and decodes it with a strict UTF-8
decoder; non-UTF-8 bytes threw `Invalid UTF-8 sequence` from inside
`getUser()`, an unhandled rejection that 500s the route — including `/login`
and `/api/auth/signout`, the two pages a user needs to recover. The realistic
trigger is not tampering: Supabase chunks large sessions across
`…auth-token.0` / `.1`, and a browser evicting one chunk produces exactly this.

`isDecodableAuthCookie()` in `lib/supabase.ts` now drops such a cookie at our
own boundary, degrading the request to "signed out", which every route already
handles. Do not remove it, and do not widen it beyond `sb-*` + `base64-` — the
PKCE verifier cookie must pass through untouched.
