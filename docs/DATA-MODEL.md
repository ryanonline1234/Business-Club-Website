# Data Model

Everything here comes from [`supabase-schema.sql`](../supabase-schema.sql) at
the repo root — base schema **plus the member-approval migration** in one
file. It is the single source of truth: no migration tooling, no ORM, no
generated types. Every statement is idempotent, so re-running the file is a
no-op and running it on an empty project builds everything from scratch.

**How to run it — three passes, not one paste.** The SQL Editor only shows the
*last* result set, so:

1. **STEP 0 alone** — the pre-flight. Read the rows it returns; they decide
   whether STEP 9 may ever be applied. (On a brand-new project it errors with
   "relation does not exist" — that counts as zero rows.)
2. **PART 1 → STEP 14** as one block.
3. **STEP 15 alone** — verification. Read it before deploying any code.
4. **STEPs 16–18 as one block** — the `/about` additions (`bio`, `recap`, the
   `photos` table). Unlike the rest, these are safe **any time, in either
   order relative to the code deploy**: nullable columns older code never
   selects, a new table nothing else references, and the code that reads them
   fails soft. See [KNOWN-GAPS.md](KNOWN-GAPS.md#steps-1618-may-not-be-applied-yet).

Deploy order is **SQL first, then code** — the wrong order strands every user
on `/pending`. See [DEPLOYMENT.md](DEPLOYMENT.md#deploy-order-sql-first-then-code).
(That constraint is about STEPs 0–15; STEPs 16–18 are exempt, as above.)

---

## Entity overview

```
auth.users ──trigger──> profiles ──┬──> events ──> attendance
  (on delete cascade)              ├──> photos ─(event_id, nullable)─> events
                                   ├──> announcements
                                   ├──> transactions ──> categories   ┐
                                   ├──> budgets ─────────┘            │ retained,
                                   └──> audit_logs                    ┘ read by nothing
```

The app touches **profiles, events, attendance, announcements, photos**. The finance
tables (`categories`, `transactions`, `budgets`, `audit_logs`) survive from
the cut finance module: kept so the data is not lost and re-enabling treasury
is a page, not a migration. Do not drop them — and note `transactions.user_id`
/ `audit_logs.user_id` FK into `profiles`, so hand-deleting a profile row that
has old finance data will fail on those keys.

---

## Tables

### `profiles`

Mirrors `auth.users`; carries role **and approval status**. Created on signup
by the `on_auth_user_created` trigger, with the OAuth callback as a fallback
(either may win the race — both are `on conflict`-safe).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | FK → `auth.users` **`on delete cascade`** (STEP 7 — the callback's `deleteUser()` on domain rejection needs it) |
| `email` | `text` | not null; refreshed on every login |
| `name` | `text` | Google `full_name` → `name` → email local part; refreshed on login |
| `role` | `text` | `'member' \| 'treasurer' \| 'admin'`, default `'member'` |
| `status` | `text` | `'pending' \| 'approved' \| 'rejected'`, default `'pending'`, not null (STEPs 1–4) |
| `approved_by` | `uuid` | FK → `profiles`; who **ruled** (declines stamped too). NULL = grandfathered, never explicitly decided |
| `approved_at` | `timestamptz` | when they ruled |
| `bio` | `text` | nullable, no default (STEP 16). Officer self-description for the **public** `/about` page; NULL = "no bio yet", section skipped. Written only by `PATCH /api/profile/bio`, which always targets the caller's own row |
| `created_at` | `timestamptz` | default `now()` |

Indexes: `idx_profiles_status`, plus the partial `idx_profiles_pending_queue`
on `created_at where status = 'pending'` for the officer queue.

The check constraints keep role/status well-formed; application code
re-validates the same values before writing (a check violation surfaces to
clients as a 409 with fixed copy, never the raw Postgres message).

### `events`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `title` | `text` | not null |
| `description` | `text` | |
| `start_time` | `timestamptz` | not null |
| `end_time` | `timestamptz` | |
| `location` | `text` | |
| `password` | `text` | **DEAD.** Nothing reads or writes it; kept only because dropping a column is irreversible. If password check-in is ever built, hash it — the old app stored it in plaintext |
| `capacity` | `integer` | validated positive on create, displayed, **never enforced** at check-in |
| `category` | `text` | default `'meeting'`; free text |
| `status` | `text` | `'active' \| 'completed' \| 'cancelled'`, default `'active'`. Nothing ever sets `'completed'`, but readers must treat it as a legitimate past state (`/about` and `/attendance` count `active` + `completed`) |
| `created_by` | `uuid` | FK → `profiles`, not null |
| `recap` | `text` | nullable, no default (STEP 17). Officer-written "what happened" prose for the **public** `/about` page; NULL = "no recap". Only past events may carry one — enforced by `PATCH /api/events/:id/recap` |
| `created_at` | `timestamptz` | |

Indexed on `start_time`, `status`, `created_by`. Deletion is soft —
`DELETE /api/events/:id/delete` sets `status = 'cancelled'`.

### `attendance`

One row per member per event.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_id` | `uuid` | FK → `events`, not null |
| `member_id` | `uuid` | FK → `profiles`, not null — **always the session user**; the API never accepts a client-supplied id |
| `checked_in_at` | `timestamptz` | default `now()` |
| `method` | `text` | `'password' \| 'qr'`; the only writer hardcodes `'qr'` |
| `qr_data` | `text` | never written |
| `created_at` | `timestamptz` | |

**Unique constraint** `attendance_event_member_unique` on
`(event_id, member_id)` — the race backstop behind the API's explicit
duplicate check. Indexed on `event_id` and `member_id`.

### `announcements`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `title` | `text` | not null |
| `body` | `text` | not null — **plain text**; rendered escaped, never `innerHTML` |
| `author_id` | `uuid` | FK → `profiles`, nullable |
| `author_name` | `text` | denormalised snapshot — survives author deletion, goes stale on rename |
| `created_at` | `timestamptz` | |

### `photos`

Photos for the public `/about` page (STEP 18). Rows point at objects in the
`club-photos` Storage bucket — the row is what renders; an object without a
row is invisible.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_id` | `uuid` | FK → `events`, **nullable** — a photo doesn't have to belong to an event (unattached ones render as "Around the club"). No cascade needed: events are soft-deleted, never removed |
| `storage_path` | `text` | not null. Always `photos/<random-uuid>.<ext>`, generated server-side — **never** derived from a client filename |
| `caption` | `text` | plain text, ≤ 300 enforced by the API |
| `uploaded_by` | `uuid` | FK → `profiles`, not null. **The one non-public column** — see the RLS note below. Same NO ACTION posture as `events.created_by`: hard-deleting a profile with uploads fails on this key |
| `created_at` | `timestamptz` | default `now()` |

Indexed on `event_id` (serves "photos of this event" on `/about` and in the
calendar's editor).

### The `club-photos` Storage bucket

Created **in the Storage dashboard, not by the SQL file**: public read, 8MB
file limit, mime allow-list `image/jpeg | png | webp | gif`. Public object
URLs are `<PUBLIC_SUPABASE_URL>/storage/v1/object/public/club-photos/<path>`.

Writes are server-side only, through the Storage REST API with the service
role key (`POST`/`DELETE /storage/v1/object/club-photos/<path>`) — no client
ever writes to the bucket, and `POST /api/photos` re-validates type (by magic
bytes) and size regardless of what the bucket config enforces, because bucket
config can drift. Uploads carry `cache-control: max-age=300` so caches can't
serve a deleted photo for long.

### The finance tables

`categories` (seeded with four rows), `transactions`, `budgets`, `audit_logs`
— schemas unchanged from the old app, read and written by nothing. Their RLS
policies were still rewritten onto the new helpers (see below) so they stay
truthful.

---

## The approval migration (STEPs 0–15)

The shape that matters, and the two ways it can lock you out:

| Step | What | Why it's shaped that way |
|---|---|---|
| 0 | Pre-flight: list non-school accounts | Decides STEP 9. **Read it first** |
| 1–3 | `status` added with **no default** → backfill NULL→`'approved'` → then default `'pending'` + NOT NULL | The one-liner `add column … not null default 'pending'` instantly un-approves every existing member including every officer. Three statements is the difference between a migration and a self-inflicted lockout |
| 4 | Check constraint | |
| 5 | `approved_by` / `approved_at` | NULL = grandfathered |
| 6 | Status index + partial pending-queue index | |
| 7 | `profiles_id_fkey` → `on delete cascade` | The callback's `deleteUser()` on a rejected domain otherwise fails on the FK |
| 8 | `is_school_email(text)` | The SQL half of the domain rule; the TS half is `isSchoolEmail()` in `lib/env.ts`. Deliberately bug-compatible (`split_part` vs `.split('@')[1]`). These two places are the whole rule |
| 9 | **CONDITIONAL, ships commented out** — DB-level domain check constraint | Only if STEP 0 returned zero rows. `NOT VALID` skips existing rows, but any later UPDATE to a grandfathered row would fail — the admin could never be changed again, by anyone |
| 10–11 | `handle_new_user` rewritten; trigger recreated idempotently | See below |
| 12 | `is_approved()` / `is_officer()` / `is_admin()` security-definer helpers | Break the self-referential-policy recursion; all three require `status='approved'` |
| 13 | Approval-aware RLS on `profiles` | Adds the officer read the old policies never had |
| 13b | `profiles_role_change_guard` trigger | See below |
| 14 | Approval-aware RLS on the other tables | A pending account reads nothing |
| 15 | Verification queries | Read before deploying code |

STEP 2 keys off `status is null`, so a re-run can never re-approve someone an
officer has since declined.

---

## Signup trigger

STEP 10's `handle_new_user()` differs from the old one in four ways:

- Writes `status`, derived from the domain: school email → `'pending'`,
  anything else → `'rejected'` (it does **not** raise — a raise surfaces as an
  opaque Supabase `server_error`; the callback owns the user-facing rejection).
- `on conflict (id) do nothing`, so it can never fight the callback fallback.
- Prefers `raw_user_meta_data->>'full_name'` first, matching the callback (the
  two paths used to produce different display names).
- `security definer set search_path = public` — the search-path pin is
  hardening, not decoration.

**The trigger is not trusted on its own.** It has been observed not to fire
(commit `37e9246`); `/api/auth/callback` independently creates the row. Both
paths write `id`/`email`/`name` only on the insert and never touch
`role`/`status` on an existing row — see
[ARCHITECTURE.md](ARCHITECTURE.md#profile-creation--and-the-one-write-you-must-never-make).

---

## Row Level Security

RLS is enabled on all nine tables and the policies are **approval-aware**:
built on the STEP 12 helpers, so a pending or rejected account reads nothing,
members read their own attendance/transactions, officers read and manage
everything, and (new in the rebuild) treasurers can actually read other
profiles.

The one exception to "pending accounts read nothing" is `photos` (STEP 18):
its select policy is `using (true)` **on purpose** — the rows render on the
public `/about` page and the objects live in a public-read bucket, so a
policy pretending otherwise would be theater. But one column is *not* public:
`uploaded_by` (which officer uploaded each photo). RLS can't restrict
columns, so STEP 18 pairs the policy with a column-level grant — `revoke
select` from `anon`/`authenticated`, then `grant select` on only
`id, event_id, storage_path, caption, created_at`. Don't "simplify" that back
to a table-level grant.

**These policies still do not gate the application.** Every app query runs
through the service-role client, which bypasses RLS entirely; authorization is
the guard layer in `lib/auth.ts`. The policies are the second line of defence
for anything that ever reaches Supabase with a user token — keep them
truthful, because the day a query moves off the service role they are all
that's left.

### The role-change guard (STEP 13b)

RLS cannot express "an officer may update this row but not this column", and
the officer update policy would otherwise let a treasurer
`update profiles set role='admin' where id = auth.uid()` under a user token.
The `profiles_role_change_guard` trigger raises `insufficient_privilege` when
`role` changes and the caller is not an approved admin.

It deliberately stands aside when `auth.uid()` is NULL — i.e. for the
service-role client (the app's own `PATCH /api/members/:id`, which
`apiRequireAdmin` already controls), the Supabase table editor, and psql.
That is what keeps manual recovery possible.

---

## Conventions

- UUID primary keys via `uuid_generate_v4()`; `uuid-ossp` enabled at the top.
- `timestamptz` everywhere, `default now()`.
- Enum-ish columns are `text` + `check` constraint rather than Postgres enums —
  adding a value is an `alter table`, not a type migration.
- Idempotency patterns: `create table if not exists`, drop-then-add for
  constraints and policies, `drop trigger if exists` before `create trigger`,
  `create or replace function`.
- Foreign keys reference `public.profiles`, not `auth.users` — except
  `profiles.id` itself, which cascades from `auth.users`.
- `numeric(10,2)` for money in the retained finance tables;
  `@supabase/supabase-js` returns those as **strings**.
