# Data Model

Everything here comes from [`supabase-schema.sql`](../supabase-schema.sql) at the
repo root. That file is the single source of truth — there are no migrations,
no ORM, and no generated types. It is written to be **idempotent** (`create table
if not exists`, `on conflict do nothing`), so re-running it against a live
database is safe.

Apply it by pasting into the Supabase SQL Editor and running it.

---

## Entity overview

```
auth.users ──trigger──> profiles ──┬──> transactions ──> categories
                                   │                        ↑
                                   ├──> budgets ────────────┘
                                   ├──> events ──> attendance
                                   ├──> announcements
                                   └──> audit_logs   (defined, never written)
```

---

## Tables

### `profiles`

Mirrors `auth.users` and carries the role. Created automatically on signup by the
`on_auth_user_created` trigger, with the auth callback as a fallback.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | FK → `auth.users` |
| `email` | `text` | not null |
| `name` | `text` | from Google metadata, or the email local part |
| `role` | `text` | `'treasurer' \| 'admin' \| 'member'`, default `'member'` |
| `created_at` | `timestamptz` | default `now()` |

The `role` check constraint is the only thing keeping roles well-formed —
application code re-validates the same three values before writing.

### `categories`

Expense buckets. Seeded with four rows on schema apply: **Budget**,
**Activities**, **Prizes**, **Snacks**.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `uuid_generate_v4()` |
| `name` | `text` | not null |
| `slug` | `text` | not null, **unique** — the seed's conflict target |
| `description` | `text` | |
| `icon` | `text` | default `'box'`; the seed sets `budget`/`activity`/`prize`/`snack` |
| `is_active` | `boolean` | default `true`; `/api/finance` filters on it |
| `created_at` | `timestamptz` | |

No endpoint creates or edits categories — manage them in the Supabase table
editor.

### `transactions`

A single expense record. Members submit; officers approve.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `amount` | `numeric(10,2)` | not null; API rejects values ≤ 0 |
| `description` | `text` | not null |
| `category_id` | `uuid` | FK → `categories`, not null |
| `user_id` | `uuid` | FK → `profiles`, not null — always the submitter |
| `status` | `text` | `'pending' \| 'approved' \| 'rejected'`, default `'pending'` |
| `receipt_url` | `text` | **no code reads or writes this** |
| `merchant` | `text` | |
| `created_at` | `timestamptz` | |

Indexed on `user_id`, `category_id`, `status`, `created_at`.

There is no `updated_at` and no record of who approved what.

### `budgets`

A spending allowance for a category over a date range.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `name` | `text` | not null |
| `amount` | `numeric(10,2)` | not null — the ceiling |
| `spent` | `numeric(10,2)` | default `0` — **never incremented by any code** |
| `category_id` | `uuid` | FK → `categories`, not null |
| `starts_at` | `timestamptz` | not null |
| `ends_at` | `timestamptz` | not null |
| `created_at` | `timestamptz` | |

Indexed on `category_id`.

`/finance` renders a progress bar from `spent / amount`, so every budget shows 0%
forever. See [KNOWN-GAPS.md](KNOWN-GAPS.md#budgetsspent-is-never-updated).

Nothing prevents overlapping budgets for the same category and period.

### `events`

Club meetings, workshops, competitions.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `title` | `text` | not null |
| `description` | `text` | |
| `start_time` | `timestamptz` | not null |
| `end_time` | `timestamptz` | |
| `location` | `text` | |
| `password` | `text` | collected by the create form, **never checked** |
| `capacity` | `integer` | stored, **never enforced** |
| `category` | `text` | default `'meeting'`; free text, no constraint |
| `status` | `text` | `'active' \| 'completed' \| 'cancelled'`, default `'active'` |
| `created_by` | `uuid` | FK → `profiles`, not null |
| `created_at` | `timestamptz` | |

Indexed on `start_time`, `status`, `created_by`.

Deletion is soft — `DELETE /api/events/:id/delete` sets `status = 'cancelled'`.
Nothing marks an event `'completed'`; that transition is unimplemented.

### `attendance`

One row per member per event.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `event_id` | `uuid` | FK → `events`, not null |
| `member_id` | `uuid` | FK → `profiles`, not null |
| `checked_in_at` | `timestamptz` | default `now()` |
| `method` | `text` | `'password' \| 'qr'`, default `'password'` |
| `qr_data` | `text` | **never written** |
| `created_at` | `timestamptz` | |

**Unique constraint** `attendance_event_member_unique` on `(event_id, member_id)`
— the database-level backstop for duplicate check-ins. The API also checks
explicitly and returns `409` first.

Indexed on `event_id` and `member_id`.

Every row written today has `method = 'qr'` (the API hardcodes it), even though
the column defaults to `'password'` — the password path was designed but never
built.

### `announcements`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `title` | `text` | not null |
| `body` | `text` | not null |
| `author_id` | `uuid` | FK → `profiles`, nullable |
| `author_name` | `text` | denormalised snapshot — survives author deletion, goes stale on rename |
| `created_at` | `timestamptz` | |

Not indexed. `GET /api/announcements` caps at 10 rows.

### `audit_logs`

Defined in full — `action`, `table_name`, `record_id`, `user_id`, `old_data`
jsonb, `new_data` jsonb, `created_at` — with an RLS read policy for officers.

**No application code ever writes to it.** Transaction deletions and role changes
leave no trail. See [KNOWN-GAPS.md](KNOWN-GAPS.md#audit_logs-is-defined-but-never-written).

---

## Signup trigger

```sql
create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          'member');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

`security definer` lets it write to `profiles` despite RLS.

**This trigger is not trusted on its own.** `/api/auth/callback` independently
checks for the profile and creates it if absent (commit `37e9246`) — the trigger
was observed not to fire reliably. Note the trigger reads
`raw_user_meta_data->>'name'` while the callback prefers `full_name`, so the two
paths can produce different display names for the same user.

Also note: `create trigger` is **not** guarded by `if not exists`, so re-running
the whole schema file on a database that already has it will error on that one
statement. Everything before it will have applied.

---

## Row Level Security

RLS is enabled on all eight tables, with policies roughly matching the role
model: members read their own rows, officers read and manage everything,
categories/budgets/events are world-readable.

**These policies do not gate this application.** Every query in the app runs
through the service-role client, which bypasses RLS entirely. Authorization is
enforced in application code — see
[ARCHITECTURE.md](ARCHITECTURE.md#rls-is-defined-but-not-enforced).

Keep the policies correct anyway: they're the safety net for anything reaching
Supabase with the anon key, and they document intent.

Two things to know if you ever do start relying on them:

- Every officer policy re-queries `profiles` as a subselect
  (`auth.uid() in (select id from profiles where role in (...))`). On `profiles`
  itself that's self-referential, which is a classic source of recursion and
  surprising empty results.
- `profiles` has a self-select policy and an admin-manage policy, but **no policy
  lets a treasurer read other profiles** — a fact currently masked by the service
  role.

---

## Conventions

- UUID primary keys via `uuid_generate_v4()`; `uuid-ossp` is enabled at the top
  of the file.
- `timestamptz` everywhere, `default now()`.
- `numeric(10,2)` for money — never floats. Note that `@supabase/supabase-js`
  returns these as **strings**, which is why the finance page wraps them in
  `Number(...)` before arithmetic.
- Enum-ish columns are `text` + `check` constraint rather than Postgres enums, so
  adding a value is an `alter table` rather than a type migration.
- Foreign keys reference `public.profiles`, not `auth.users`, except for
  `profiles.id` itself.
