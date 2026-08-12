-- ═══════════════════════════════════════════════════════════════════════════
-- The Mitty Business Club — officer portal
-- Canonical Supabase schema + the member-approval migration.
--
-- HOW TO RUN THIS FILE
--   In the Supabase SQL Editor, in four passes:
--     1. STEP 0 alone      — pre-flight. READ THE ROWS IT RETURNS. Its result
--                            decides whether STEP 9 may be applied at all.
--                            On a brand-new project this statement errors with
--                            'relation "public.profiles" does not exist'; that
--                            counts as zero rows, so just skip to pass 2.
--     2. PART 1 → STEP 14  — the schema and the migration. Safe to paste as
--                            one block; every statement is idempotent, so
--                            running it twice is a no-op and running it on an
--                            empty project builds everything from scratch.
--     3. STEP 15 alone     — verification. READ THE ROWS IT RETURNS, before
--                            deploying any code.
--     4. STEPs 16-19       — paste as one block, safe any time, in either
--                            order relative to the code deploy (see their
--                            banners). One caveat: STEP 19 re-approves EVERY
--                            school-domain row sitting at 'pending' — not
--                            just pre-cutover queue residue — so an account
--                            you want locked out must be parked at
--                            'rejected', never 'pending', or the next
--                            re-paste silently lets it back in.
--
--   Passes 1 and 3 are separate because the SQL Editor only shows the LAST
--   result set: paste everything at once and you never see what STEP 0 said.
--
--   STEP 9 ships COMMENTED OUT on purpose. It is CONDITIONAL — see its banner.
--
-- ⛔ DO NOT DEPLOY THIS YET — /pending AND THE APPROVAL UI DO NOT EXIST ⛔
--   As of this writing src/pages/pending.astro has never been written, and no
--   page calls PATCH /api/members/:id/status. Run this migration against the
--   current front end and the result is a closed loop with no exit:
--     • every new @mittymonarch.com signup is created 'pending' (STEP 3's
--       default; STEP 10 wrote 'pending' too until the 2026-08-12
--       auto-approval — see its banner);
--     • the guards and the OAuth callback send them to /pending — a 404;
--     • no officer screen can approve them, so the only way out is editing
--       rows by hand in the Supabase table editor.
--   Existing members are safe (STEP 2 backfills them to 'approved'), so this is
--   a lockout for NEW members only — but that is the entire feature.
--   SHIP THE /pending PAGE AND THE OFFICER APPROVAL QUEUE FIRST.
--
-- DEPLOY ORDER: THIS FILE FIRST, THEN THE CODE.
--   The app selects profiles.status. If the new build ships before this
--   migration runs, that select errors, getSession fails closed by design,
--   and 100% of users land on /pending with no way out. The other order is
--   safe: this migration against the OLD code only means brand-new signups
--   carry a status the old app ignores.
--
-- TABLES IN PLAY for the app: profiles, events, attendance, announcements.
-- The finance tables (categories, transactions, budgets, audit_logs) are
-- deliberately RETAINED but read by nothing. Do not drop them.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 0: PRE-FLIGHT  ── RUN THIS ALONE, BEFORE ANYTHING ELSE, AND READ IT ──
-- ═══════════════════════════════════════════════════════════════════════════
-- Every row this returns is an existing account on a non-school domain.
-- If your own admin row is here, DO NOT add the domain CHECK constraint in
-- STEP 9 and make sure the callback grandfathers already-approved profiles.
--
-- On a brand-new project this errors with 'relation "public.profiles" does
-- not exist'. That counts as zero rows — carry on.

select id, email, role, created_at from public.profiles
where lower(split_part(email, '@', 2)) not in ('mittymonarch.com', 'mitty.com')
order by created_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — BASE SCHEMA (tables, indexes, RLS switched on)
-- Unchanged from the original schema. Policies for profiles / events /
-- attendance / announcements are NOT defined here — STEP 13 and STEP 14 own
-- them, so there is exactly one definition of each policy in this file.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";

-- Members. One row per auth.users row; `status` is added by STEP 1-4 rather
-- than declared here, because existing databases need the backfill.
create table if not exists public.profiles (
  id uuid references auth.users not null primary key,
  email text not null,
  name text,
  role text default 'member' check (role in ('treasurer', 'admin', 'member')),
  created_at timestamptz default now()
);

-- Events (club meetings, workshops, competitions).
-- NOTE: `password` is DEAD. Nothing reads or writes it; the column is kept
-- only because dropping columns is irreversible. If password check-in is ever
-- built, hash the value — never store it in plaintext as the old code did.
create table if not exists public.events (
  id uuid default uuid_generate_v4() primary key,
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz,
  location text,
  password text,
  capacity integer,
  category text default 'meeting',
  status text default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_by uuid references public.profiles not null,
  created_at timestamptz default now()
);

-- Event check-ins.
create table if not exists public.attendance (
  id uuid default uuid_generate_v4() primary key,
  event_id uuid references public.events not null,
  member_id uuid references public.profiles not null,
  checked_in_at timestamptz default now(),
  method text default 'password' check (method in ('password', 'qr')),
  qr_data text,
  created_at timestamptz default now()
);

-- One check-in per member per event. drop-then-add keeps the file re-runnable
-- (the original bare `add constraint` errored on every second run).
alter table public.attendance
  drop constraint if exists attendance_event_member_unique;

alter table public.attendance
  add constraint attendance_event_member_unique unique (event_id, member_id);

-- Announcements.
create table if not exists public.announcements (
  id uuid default uuid_generate_v4() primary key,
  title text not null,
  body text not null,
  author_id uuid references public.profiles,
  author_name text,
  created_at timestamptz default now()
);

-- ── Finance tables: RETAINED, READ BY NOTHING ──────────────────────────────
-- The finance module was deleted from the app. These tables stay so the data
-- is not lost and the decision stays reversible. Note that transactions.user_id
-- and audit_logs.user_id reference public.profiles, so hard-deleting a profile
-- row by hand will fail on these foreign keys.
create table if not exists public.categories (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  slug text not null unique,
  description text,
  icon text default 'box',
  is_active boolean default true,
  created_at timestamptz default now()
);

insert into public.categories (name, slug, description, icon) values
  ('Budget', 'budget', 'General budget expenses', 'budget'),
  ('Activities', 'activities', 'Club activities and events', 'activity'),
  ('Prizes', 'prizes', 'Prizes and rewards', 'prize'),
  ('Snacks', 'snacks', 'Snacks and refreshments', 'snack')
on conflict (slug) do nothing;

create table if not exists public.transactions (
  id uuid default uuid_generate_v4() primary key,
  amount numeric(10, 2) not null,
  description text not null,
  category_id uuid references public.categories not null,
  user_id uuid references public.profiles not null,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  receipt_url text,
  merchant text,
  created_at timestamptz default now()
);

create table if not exists public.budgets (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  amount numeric(10, 2) not null,
  spent numeric(10, 2) default 0,
  category_id uuid references public.categories not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz default now()
);

create table if not exists public.audit_logs (
  id uuid default uuid_generate_v4() primary key,
  action text not null,
  table_name text not null,
  record_id uuid,
  user_id uuid references public.profiles,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────────
create index if not exists idx_events_start_time on public.events(start_time);
create index if not exists idx_events_status on public.events(status);
create index if not exists idx_events_created_by on public.events(created_by);
create index if not exists idx_attendance_event_id on public.attendance(event_id);
create index if not exists idx_attendance_member_id on public.attendance(member_id);
create index if not exists idx_transactions_user_id on public.transactions(user_id);
create index if not exists idx_transactions_category_id on public.transactions(category_id);
create index if not exists idx_transactions_status on public.transactions(status);
create index if not exists idx_transactions_created_at on public.transactions(created_at);
create index if not exists idx_budgets_category_id on public.budgets(category_id);

-- ── Row Level Security: on for every table ─────────────────────────────────
-- Every application query currently runs through the service-role client, so
-- these policies do not gate the app today. They must still be TRUTHFUL: they
-- are the second line of defence the day any query moves off the service role.
alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.attendance enable row level security;
alter table public.announcements enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets enable row level security;
alter table public.audit_logs enable row level security;


-- ═══════════════════════════════════════════════════════════════════════════
-- THE APPROVAL MIGRATION — STEPS 1 THROUGH 15
--
-- ⚠ WHY STEPS 1-2-3 ARE THREE SEPARATE STATEMENTS, IN THAT ORDER ⚠
--
--   The obvious one-liner —
--       alter table public.profiles
--         add column status text not null default 'pending';
--   — instantly flips EVERY existing member, including every officer, to
--   'pending'. The roster empties, the approval queue fills with people who
--   were already approved, and nobody with the power to fix it can log in.
--
--   The three-step dance avoids that:
--     1. add the column with NO default  → existing rows get NULL
--     2. backfill NULL → 'approved'      → everyone who exists today keeps access
--     3. NOW set default 'pending' + NOT NULL → only FUTURE signups are pending
--
--   Step 2 keys off "status is null", so a second run finds no NULLs and
--   this statement can never re-approve someone an officer has since set to
--   'pending' or 'rejected'. That guarantee is STEP 2's alone, not the
--   file's: STEP 19 (end of file) re-approves any school-domain row still
--   at 'pending' on every run. 'rejected' survives everything — a manual
--   suspension in the table editor must use 'rejected', never 'pending'.
--
--   Run STEP 1-3 together, then read STEP 15 before deploying any code.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 1: add the approval column WITHOUT a default ──────────────────────
-- No default here on purpose: existing rows come back NULL rather than
-- 'pending', which is what makes the backfill in step 2 possible.
alter table public.profiles
  add column if not exists status text;

-- ── STEP 2: backfill existing members to 'approved' ────────────────────────
-- This MUST run before the default is set. Every member who exists today keeps
-- their access. Re-running THIS statement is a no-op (no NULLs left) — but a
-- re-run of the whole file also hits STEP 19, which approves school rows
-- still at 'pending'. See its banner.
update public.profiles
   set status = 'approved'
 where status is null;

-- ── STEP 3: new signups default to 'pending', column becomes non-null ──────
alter table public.profiles
  alter column status set default 'pending';

alter table public.profiles
  alter column status set not null;

-- ── STEP 4: constrain the allowed values (drop-then-add keeps it re-runnable)
alter table public.profiles
  drop constraint if exists profiles_status_check;

alter table public.profiles
  add constraint profiles_status_check
  check (status in ('pending', 'approved', 'rejected'));

-- ── STEP 5: approval provenance ────────────────────────────────────────────
-- Null on backfilled rows — that is the marker for 'grandfathered, never
-- explicitly approved by anyone'.
alter table public.profiles
  add column if not exists approved_by uuid references public.profiles(id);

alter table public.profiles
  add column if not exists approved_at timestamptz;

-- ── STEP 6: indexes ────────────────────────────────────────────────────────
-- idx_profiles_status serves the roster (status = 'approved') on every page;
-- the partial index serves the officer approval queue ordered by signup time.
create index if not exists idx_profiles_status
  on public.profiles(status);

create index if not exists idx_profiles_pending_queue
  on public.profiles(created_at)
  where status = 'pending';

-- ── STEP 7: make profiles.id cascade from auth.users ───────────────────────
-- The original inline `references auth.users` has ON DELETE NO ACTION, so
-- supabaseAdmin.auth.admin.deleteUser() fails with an FK violation. The
-- rejected-domain path in /api/auth/callback needs this delete to succeed.
alter table public.profiles
  drop constraint if exists profiles_id_fkey;

alter table public.profiles
  add constraint profiles_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- ── STEP 8: the school-domain predicate, in one place ──────────────────────
-- Mirrored in TypeScript by isSchoolEmail() in src/lib/env.ts. If the club
-- ever changes domains, these two are the only places to edit.
create or replace function public.is_school_email(addr text)
returns boolean as $$
  select lower(split_part(coalesce(addr, ''), '@', 2))
         in ('mittymonarch.com', 'mitty.com');
$$ language sql immutable;


-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠⚠ STEP 9 — CONDITIONAL. DO NOT RUN IT UNLESS STEP 0 RETURNED ZERO ROWS ⚠⚠
--
--   It ships COMMENTED OUT so that pasting this whole file is safe by default.
--   Skipping it costs nothing (the domain rule is enforced in the OAuth
--   callback and by the signup trigger); applying it wrongly is a lockout.
--
--   Hard DB-level domain enforcement. NOT VALID skips existing rows, but any
--   future UPDATE to a violating row still fails — so a grandfathered gmail
--   admin could never have their role or status changed again, by anyone,
--   including through the Supabase table editor.
--
--   IF AND ONLY IF STEP 0 RETURNED NO ROWS: uncomment the four lines below
--   and run them.
-- ═══════════════════════════════════════════════════════════════════════════

-- alter table public.profiles
--   drop constraint if exists profiles_school_email_check;
--
-- alter table public.profiles
--   add constraint profiles_school_email_check
--   check (public.is_school_email(email) or status = 'rejected')
--   not valid;


-- ── STEP 10: replace the signup trigger ────────────────────────────────────
-- AUTO-APPROVAL (2026-08-12): school-domain signups are created 'approved',
-- not 'pending'. This was a deliberate owner decision — the approval queue
-- felt too strict — not an accident; do not "fix" it back. Moderation is now
-- AFTER the fact: an officer decline (PATCH /api/members/:id/status) flips
-- the row to 'rejected' and locks the account out, and it STAYS rejected on
-- every later sign-in because the callback never rewrites status on a
-- returning login. Decline is the moderation lever; the queue is not a gate.
--
-- Changes vs the original:
--   * writes `status`, derived from the email domain: school → 'approved'
--     (auto-approval, above), anything else → 'rejected'
--   * does NOT raise on a bad domain — it marks the row 'rejected' and lets
--     /api/auth/callback own the user-facing rejection, because a raise here
--     surfaces as an opaque Supabase server_error with no message we control
--   * `on conflict (id) do nothing` so it can never fight the callback fallback
--   * prefers raw_user_meta_data->>'full_name' first, matching the callback
--     (the two paths previously produced different display names)
--   * `set search_path = public` hardens the security definer function
--
-- RE-RUN NOTE: if STEPs 0-15 were applied BEFORE 2026-08-12, the live trigger
-- still writes 'pending' for school signups. Re-paste STEP 10 and STEP 19
-- (end of file) as one block — both are idempotent and safe at any time, in
-- either order relative to the code deploy.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name, role, status)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    ),
    'member',
    case when public.is_school_email(new.email) then 'approved' else 'rejected' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ── STEP 11: recreate the trigger idempotently ─────────────────────────────
-- The original `create trigger` had no guard, so re-running the schema file
-- always errored on this statement. drop-if-exists fixes that wart.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── STEP 12: non-recursive RLS helpers ─────────────────────────────────────
-- The old officer policies did `auth.uid() in (select id from profiles
-- where role in (...))`, which is self-referential on profiles itself.
-- security definer functions break the recursion and add the status check.
-- `set search_path = public` is load-bearing, not decoration: these run with
-- the owner's privileges.
create or replace function public.is_approved()
returns boolean as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and status = 'approved'
  );
$$ language sql stable security definer set search_path = public;

create or replace function public.is_officer()
returns boolean as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and status = 'approved'
       and role in ('admin', 'treasurer')
  );
$$ language sql stable security definer set search_path = public;

create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid() and status = 'approved' and role = 'admin'
  );
$$ language sql stable security definer set search_path = public;

-- ── STEP 13: approval-aware RLS on profiles ────────────────────────────────
-- These do not gate the app today (every query runs as service role) but they
-- must stay truthful, and they are the backstop if anything ever queries with
-- the anon key. Note the original had NO policy letting a treasurer read other
-- profiles — fixed here.
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Admin can manage all profiles" on public.profiles;
drop policy if exists "Officers can view all profiles" on public.profiles;
drop policy if exists "Officers can set approval status" on public.profiles;
drop policy if exists "Admins can manage all profiles" on public.profiles;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Officers can view all profiles"
  on public.profiles for select
  using (public.is_officer());

-- The policy NAME says approval status; the GRANT is every column, because RLS
-- has no column-level restriction. `with check` does not fix that — and note it
-- is not even a behaviour change: Postgres already reuses `using` as the
-- `with check` expression when the latter is omitted. It is spelled out here so
-- nobody reads its absence as a hole and "fixes" it instead of the real one.
--
-- THE REAL RESTRICTION IS THE TRIGGER BELOW. Without it, this policy lets a
-- TREASURER run `update profiles set role='admin' where id = auth.uid()` under
-- the anon key, which contradicts the app's admin-only rule on role changes.
create policy "Officers can set approval status"
  on public.profiles for update
  using (public.is_officer())
  with check (public.is_officer());

create policy "Admins can manage all profiles"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

-- ── STEP 13b: role changes are admin-only, enforced in the database ─────────
-- WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
--   Not for: the app's own role endpoint. PATCH /api/members/:id runs through
--   supabaseAdmin, whose service-role JWT carries no `sub`, so auth.uid() is
--   NULL there and this trigger deliberately stands aside — apiRequireAdmin is
--   the control on that path and it is already correct. Same for the Supabase
--   table editor and psql, which is what keeps manual recovery possible.
--
--   For: any query that ever runs with an END-USER token. STEP 12-14 exist to
--   be a truthful second line of defence in exactly that case, and RLS alone
--   cannot express "an officer may update this row but not this column".
--
-- Fires on every profiles UPDATE, but the raise only triggers when `role`
-- actually changes, so the callback's email/name refresh and the approval
-- endpoint's status write are untouched.
create or replace function public.enforce_admin_only_role_change()
returns trigger as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception
      'only an approved admin may change a member role (attempted % -> %)',
      old.role, new.role
      using errcode = '42501';  -- insufficient_privilege
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists profiles_role_change_guard on public.profiles;

create trigger profiles_role_change_guard
  before update on public.profiles
  for each row execute function public.enforce_admin_only_role_change();

-- ── STEP 14: approval-aware RLS on events / announcements / attendance ─────
-- Closes the world-readable events policy and the 'any authenticated user'
-- announcements policy; a pending account now reads nothing.
drop policy if exists "Public can read events" on public.events;
drop policy if exists "Admin/Treasurer can manage events" on public.events;
drop policy if exists "Approved members can read events" on public.events;
drop policy if exists "Officers can manage events" on public.events;

create policy "Approved members can read events"
  on public.events for select
  using (public.is_approved());

create policy "Officers can manage events"
  on public.events for all
  using (public.is_officer());

drop policy if exists "Anyone authenticated can read announcements" on public.announcements;
drop policy if exists "Admin/Treasurer can manage announcements" on public.announcements;
drop policy if exists "Approved members can read announcements" on public.announcements;
drop policy if exists "Officers can manage announcements" on public.announcements;

create policy "Approved members can read announcements"
  on public.announcements for select
  using (public.is_approved());

create policy "Officers can manage announcements"
  on public.announcements for all
  using (public.is_officer());

drop policy if exists "Users can view own attendance" on public.attendance;
drop policy if exists "Admin/Treasurer can view all attendance" on public.attendance;
drop policy if exists "Users can insert own attendance" on public.attendance;
drop policy if exists "Admin/Treasurer can manage all attendance" on public.attendance;
drop policy if exists "Officers can view all attendance" on public.attendance;
drop policy if exists "Approved members can insert own attendance" on public.attendance;
drop policy if exists "Officers can manage all attendance" on public.attendance;

create policy "Users can view own attendance"
  on public.attendance for select
  using (auth.uid() = member_id and public.is_approved());

create policy "Officers can view all attendance"
  on public.attendance for select
  using (public.is_officer());

create policy "Approved members can insert own attendance"
  on public.attendance for insert
  with check (auth.uid() = member_id and public.is_approved());

create policy "Officers can manage all attendance"
  on public.attendance for all
  using (public.is_officer());

-- ── Finance-table policies (unused module, kept truthful and re-runnable) ──
-- Rewritten onto the STEP 12 helpers so an approved-but-pending account can
-- never read them either. Behaviour is otherwise unchanged.
drop policy if exists "Public can read categories" on public.categories;
drop policy if exists "Admin/Treasurer can manage categories" on public.categories;
drop policy if exists "Approved members can read categories" on public.categories;
drop policy if exists "Officers can manage categories" on public.categories;

create policy "Approved members can read categories"
  on public.categories for select
  using (public.is_approved());

create policy "Officers can manage categories"
  on public.categories for all
  using (public.is_officer());

drop policy if exists "Users can read own transactions" on public.transactions;
drop policy if exists "Admin/Treasurer can read all transactions" on public.transactions;
drop policy if exists "Users can insert own transactions" on public.transactions;
drop policy if exists "Admin/Treasurer can manage all transactions" on public.transactions;
drop policy if exists "Officers can read all transactions" on public.transactions;
drop policy if exists "Approved members can insert own transactions" on public.transactions;
drop policy if exists "Officers can manage all transactions" on public.transactions;

create policy "Users can read own transactions"
  on public.transactions for select
  using (auth.uid() = user_id and public.is_approved());

create policy "Officers can read all transactions"
  on public.transactions for select
  using (public.is_officer());

create policy "Approved members can insert own transactions"
  on public.transactions for insert
  with check (auth.uid() = user_id and public.is_approved());

create policy "Officers can manage all transactions"
  on public.transactions for all
  using (public.is_officer());

drop policy if exists "Public can read budgets" on public.budgets;
drop policy if exists "Admin/Treasurer can manage budgets" on public.budgets;
drop policy if exists "Approved members can read budgets" on public.budgets;
drop policy if exists "Officers can manage budgets" on public.budgets;

create policy "Approved members can read budgets"
  on public.budgets for select
  using (public.is_approved());

create policy "Officers can manage budgets"
  on public.budgets for all
  using (public.is_officer());

drop policy if exists "Admin/Treasurer can read audit logs" on public.audit_logs;
drop policy if exists "Officers can read audit logs" on public.audit_logs;

create policy "Officers can read audit logs"
  on public.audit_logs for select
  using (public.is_officer());


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 15: VERIFICATION  ── RUN THIS ALONE, AFTER EVERYTHING ABOVE, AND READ IT
-- ═══════════════════════════════════════════════════════════════════════════
-- Expect: zero pending rows that predate this migration, and exactly the
-- accounts you expect in each bucket. If anyone who had access yesterday shows
-- up as 'pending', STEP 2 did not run before STEP 3 — fix it before deploying
-- the code, with:  update public.profiles set status='approved' where id='…';

select status, count(*) from public.profiles group by status order by status;

select id, email, name, role, status, created_at
  from public.profiles
 order by status, created_at;


-- ═══════════════════════════════════════════════════════════════════════════
-- PUBLIC /about PAGE — STEPS 16-18
--
-- ✅ SAFE TO RUN ANY TIME, in either order relative to the code deploy, on a
--   live database, repeatedly. Unlike STEPs 1-15 there is no lockout surface
--   here: no default changes, no backfill, no NOT NULL added to an existing
--   column. STEPs 16-17 add nullable columns that older code never selects;
--   STEP 18 creates a brand-new table nothing else references. The /about
--   code is written fail-soft — a missing bio/recap column or photos table
--   renders as an empty section, never a 500 — so code-before-SQL and
--   SQL-before-code both work. Paste STEPs 16-18 as one block; every
--   statement is idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 16: officer self-description for the public /about page ───────────
-- Nullable, no default: NULL means "no bio yet" and the page skips that
-- officer's description. Written only by PATCH /api/profile/bio, which always
-- targets the caller's own row (id from the session, never the request body).
alter table public.profiles
  add column if not exists bio text;

-- ── STEP 17: officer-written recap for past events ──────────────────────────
-- "What happened" prose for the /about page's What We've Done section. Only
-- events whose start_time is already in the past can carry one (enforced by
-- PATCH /api/events/:id/recap — recaps are history, not previews). Nullable,
-- no default; NULL means "no recap written".
alter table public.events
  add column if not exists recap text;

-- ── STEP 18: photos for the public /about page ──────────────────────────────
-- Rows here point at objects in the `club-photos` Storage bucket (public read,
-- 8MB, image mime allow-list — created separately in the Storage dashboard,
-- not by this file). storage_path is always photos/<random-uuid>.<ext>,
-- generated server-side; it is never derived from a client filename.
--
-- FK notes, same posture as the finance tables: uploaded_by references
-- profiles with NO ACTION, so hard-deleting a profile row that has uploads
-- fails on this constraint (events.created_by already behaves this way for
-- officers, so this adds no new restriction in practice). event_id is
-- NULLABLE — a photo does not have to belong to an event — and events are
-- soft-deleted (status → 'cancelled'), never removed, so no cascade is needed.
create table if not exists public.photos (
  id uuid default uuid_generate_v4() primary key,
  event_id uuid references public.events,
  storage_path text not null,
  caption text,
  uploaded_by uuid references public.profiles not null,
  created_at timestamptz default now()
);

alter table public.photos enable row level security;

-- Serves "photos of this event" on /about and in the portal's event views.
create index if not exists idx_photos_event_id on public.photos(event_id);

-- Photo RLS. The select policy is `using (true)` ON PURPOSE and that is the
-- honest choice, not an oversight: these rows render on the PUBLIC /about
-- page and the storage objects live in a public-read bucket, so a policy
-- pretending the row data is private would be theater. Writes stay
-- officer-only via the STEP 12 helper. (As everywhere else in this file, the
-- app queries through the service role today; these policies are the truthful
-- second line of defence.)
--
-- ONE COLUMN IS NOT PUBLIC: uploaded_by. It names which officer's profile
-- uploaded each photo — /about never selects it, so the public set is only
-- what the page can render (storage_path, caption, event_id, plus the
-- harmless id/created_at). RLS cannot restrict columns, and Supabase's
-- default privileges grant anon/authenticated SELECT on every column of a
-- new public-schema table, so without the revoke+grant below the
-- `using (true)` policy would let anyone read uploaded_by through PostgREST
-- with the (public-by-design) anon key. The column-level grant keeps the
-- policy honest AND the boundary real. Both statements converge on re-run.
drop policy if exists "Public can read photos" on public.photos;
drop policy if exists "Officers can manage photos" on public.photos;

create policy "Public can read photos"
  on public.photos for select
  using (true);

create policy "Officers can manage photos"
  on public.photos for all
  using (public.is_officer())
  with check (public.is_officer());

revoke select on public.photos from anon, authenticated;
grant select (id, event_id, storage_path, caption, created_at)
  on public.photos to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- AUTO-APPROVAL BACKFILL — STEP 19
--
-- ✅ SAFE TO RUN ANY TIME, repeatedly, on a live database. Pairs with the
--   2026-08-12 STEP 10 rewrite (see its banner and RE-RUN NOTE).
-- ⚠️ "SAFE" MEANS "CANNOT LOCK ANYONE OUT" — NOT "CHANGES NOTHING". Every
--   run approves EVERY school-domain row sitting at 'pending' at that
--   moment, not just pre-cutover queue residue. An account parked at
--   'pending' by hand in the table editor is un-parked by the next re-paste
--   of this file — it will look like the account "came back on its own".
--   To suspend an account manually, set it to 'rejected': 'rejected'
--   survives this statement; 'pending' does not.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 19: clear the pre-auto-approval queue ─────────────────────────────
-- Backfill for databases migrated before 2026-08-12: any school account
-- still parked at 'pending' — queue residue from the era when the trigger
-- created school signups pending — is approved, matching what STEP 10 now
-- does at signup. Keyed on status='pending' AND the school-domain predicate,
-- so it can NEVER touch a 'rejected' row: officer declines survive this
-- statement. The predicate has no memory of WHY a row is pending, though —
-- the app never writes 'pending' (the status endpoint allows only
-- approved/rejected), so the only pending rows should be queue residue, but
-- a hand-edited 'pending' looks identical and gets approved too (banner
-- above). approved_by / approved_at stay NULL — the same "approved by the
-- rule, not by an officer" marker the STEP 2 backfill leaves.
update public.profiles
   set status = 'approved'
 where status = 'pending'
   and public.is_school_email(email);
