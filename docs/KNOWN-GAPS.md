# Known Gaps

Things that are half-built, defined-but-unused, or genuinely wrong. Written down
so nobody rediscovers them the hard way.

Nothing here has been changed — this is a description of the code as it stands,
not a changelog. Severity is a judgement call for a high-school club dashboard,
not a generic risk rating.

---

## Security

### QR check-in can be done on anyone's behalf

**Severity: high** · [`api/attendance/checkin.ts`](../club-dashboard-astro/src/pages/api/attendance/checkin.ts)

The endpoint is public and accepts `member_id` straight from the request body:

```ts
let resolvedMemberId = member_id;              // ← from the POST body, unchecked
if (!resolvedMemberId) {
  const user = await getSession(request, responseHeaders);
  if (user) resolvedMemberId = user.id;
}
```

Anyone holding a valid QR token — which is any member who scanned it, or anyone
who photographed the projected code — can check in an arbitrary member by id.
The session fallback only applies when `member_id` is absent, so supplying it
skips authentication entirely.

Member ids are also not secret: `GET /api/members` returns the full roster with
ids to any signed-in user.

*Shape of a fix:* drop `member_id` and always resolve from the session, or
restrict it to officer callers.

### Unauthenticated read endpoints

**Severity: medium**

Three `GET` endpoints have no session check at all:

| Endpoint | Exposes |
|---|---|
| `GET /api/events` | Every event: title, description, time, location, status |
| `GET /api/announcements` | The 10 most recent announcements in full |
| `GET /api/events/:id/qr` | **A freshly minted, valid check-in token for any event id** |

The last one is the sharp edge. Anyone who learns an event's UUID can mint their
own check-in QR without ever signing in, then combine it with the `member_id`
issue above to write attendance records for arbitrary members.

`GET /api/events` returns `created_by` (a profile UUID) publicly, which is where
those event ids and a member id can come from together.

Note that `/api/events` deliberately does not select the `password` column, so
event passwords aren't leaked here.

*Shape of a fix:* add `getSession` guards; gate `/qr` to officers specifically.

### Service role is the only database identity

**Severity: structural — by design, but know what it costs**

Every query in the app uses `supabaseAdmin`, which bypasses Row Level Security.
The RLS policies in `supabase-schema.sql` are live but inert for this app.

This was a deliberate call (RLS was causing silent empty-result bugs during
development, per the comment in `lib/auth.ts`), and it's defensible for an app
this size. The cost: **every new query is unrestricted by default.** Forget a
role check in a new endpoint and there is no second line of defence.

See [ARCHITECTURE.md](ARCHITECTURE.md#rls-is-defined-but-not-enforced).

### `GET /api/attendance` and `/api/members` are not scoped

**Severity: low**

Both return the full dataset to any signed-in member — the entire check-in log
and the whole roster with emails. The RLS policies say members should see only
their own attendance; the service-role client means they don't apply. Probably
fine for a club, worth knowing.

### No guard on demoting the last admin

**Severity: low** · [`api/members/[id].ts`](../club-dashboard-astro/src/pages/api/members/[id].ts)

`PATCH /api/members/:id` lets an admin demote themselves or the only other admin,
after which nobody can promote anyone and recovery requires the Supabase table
editor.

---

## Unimplemented schema features

Columns and tables exist in `supabase-schema.sql` with no code behind them.
Either build them or drop them — leaving them is how a schema stops being
trustworthy documentation.

### `budgets.spent` is never updated

**This one is user-visible.** `POST /api/finance/budgets` inserts `spent: 0`, and
nothing ever increments it. `/finance` renders a progress bar and an "over
budget" warning from `spent / amount`:

```js
const pct  = Math.min(100, Math.round((Number(b.spent) / Number(b.amount)) * 100));
const over = Number(b.spent) > Number(b.amount);
```

So every budget displays **0% spent, forever**, and the over-budget warning can
never fire. The data to compute it exists — approved transactions carry an
`amount`, a `category_id`, and a `created_at` — it's just never joined.

*Shape of a fix:* derive `spent` at read time by summing approved transactions in
the category and date window, rather than maintaining a denormalised counter.

### `events.password` is collected and stored but never checked

The create-event form has a password field labelled *"Members enter this to check
in"*, and `POST /api/events/create` persists it. Nothing reads it. `attendance.method`
allows `'password'` and even **defaults** to it, but the only check-in path
hardcodes `method: 'qr'`.

A whole password-based check-in flow was designed and never built. Officers
filling in that field reasonably expect it to do something.

### `audit_logs` is defined but never written

Full table (`action`, `table_name`, `record_id`, `user_id`, `old_data`,
`new_data`) plus an officer-only RLS read policy. Zero writes anywhere in the
codebase.

Meanwhile `DELETE /api/finance/transactions/:id` and
`DELETE /api/announcements/:id` are hard deletes, and role changes overwrite in
place — so the three actions most worth auditing leave no trace at all.

### `transactions.receipt_url` — no upload path

The column exists and the old README advertised "Receipt Uploads" as a feature.
There is no upload UI, no Supabase Storage bucket configured, and no code
referencing the column.

### `attendance.qr_data` — never written

Always null.

### `events.capacity` — stored, never enforced

Parsed and persisted on create; no check-in path compares attendance count
against it.

### `events.status = 'completed'` — unreachable

The check constraint allows `'active'`, `'completed'`, `'cancelled'`. Events are
created `'active'` and can be soft-deleted to `'cancelled'`. Nothing ever sets
`'completed'`.

### No budget edit or delete

`POST /api/finance/budgets` is the only budget endpoint. Fixing a typo in a
budget means opening the Supabase table editor.

### No category management

`categories` is seeded by the schema file and never touched again by application
code.

---

## The dead Next.js app

**Open decision.**

The repo root holds a complete Next.js 16 + NextAuth application — `src/app/`,
`src/components/`, `src/lib/`, `next.config.ts`, `eslint.config.mjs`,
`postcss.config.mjs`, `public/`, and a root `package.json` with React 19,
`next-auth@5.0.0-beta`, and Tailwind 4.

It is not deployed. `vercel.json` explicitly skips the root install and builds
`club-dashboard-astro/` instead.

It's actively costly:

- The README documented it exclusively until now, including **environment
  variable names that don't work** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXTAUTH_SECRET`,
  `NEXTAUTH_URL`, `GOOGLE_CLIENT_ID`/`SECRET`) — none of which the Astro app
  reads.
- `AGENTS.md` warns about Next.js conventions, aiming AI coding agents at the
  wrong framework entirely.
- Root-level `npm run lint` and Dependabot alerts refer to code that never runs.
- It duplicates the domain — its own `lib/supabase.ts`, `lib/auth.ts`,
  `lib/qrcode.ts`, and a partial API surface — so a search for "where is
  check-in handled?" returns two answers.

Its API surface is a strict subset of the Astro app's (transactions, categories,
events, attendance; no finance/budgets, no announcements, no member roles), so
there is nothing in it to port.

*Options:* delete it, move it to an `archive/` directory, or leave it and rely on
the README pointer added above. Deleting is the honest option; it's recoverable
from git history either way. **Not deciding this unilaterally — it's a call for
the repo owner.**

---

## Operational

### No tests, no CI

No test suite, no test runner in `club-dashboard-astro/package.json`, no GitHub
Actions workflow. The Astro app has no lint script either. The only pre-merge
signal is whether `astro build` succeeds on Vercel.

### Local dev writes to production data

There's no local Supabase instance and no seed script — `npm run dev` points at
whatever project `.env` names. Every local experiment mutates real club data
unless a second Supabase project is set up.

### `SITE_URL` breaks preview deployments

A single static origin used for OAuth `redirectTo` and every post-auth redirect.
Vercel preview deployments get unique URLs, so sign-in from a preview sends the
user to production. Fix by deriving the origin from the request (`getSession`
already has a fallback of this shape: `import.meta.env.SITE_URL ?? new URL(request.url).origin`)
or by setting `SITE_URL` per Vercel environment.

### Hardcoded term label

`DashboardLayout.astro` defaults `subtitle` to `'Spring 2026 · Officer View'`.
It'll need a manual edit each term.

### Inconsistent API response shapes

Some endpoints return `{ data }`, some a bare array, some `{ success: true }`.
Every consumer is in this repo so nothing is broken by it, but it makes the API
harder to use from anywhere else. Documented per-endpoint in [API.md](API.md).

### Mutations reload the whole page

Every client script does `location.reload()` after a successful `fetch`. Fine at
current scale; the pattern to replace first if the pages get heavier.

### Author name goes stale

`announcements.author_name` is a denormalised snapshot taken at post time. Rename
a member and their old announcements keep the old name. Deliberate enough
(it survives author deletion), just know it's not a live join.
