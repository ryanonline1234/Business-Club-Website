# Deployment & Setup

Getting the app running locally and on Vercel — and the ordering rules that
make the difference between a deploy and a lockout. If you read one section,
read [Deploy order](#deploy-order-sql-first-then-code).

---

## Deploy order: SQL first, then code

The app selects `profiles.status` on every request. The sequence:

1. **STEP 0 pre-flight** — run it alone in the Supabase SQL Editor and **read
   the rows**: every row is an existing account on a non-school domain. If
   the admin's own row is there (it is — the club admin uses a personal
   address), STEP 9 must never be applied. On a brand-new project STEP 0
   errors with "relation does not exist"; that counts as zero rows.
2. **Apply [`supabase-schema.sql`](../supabase-schema.sql)** — PART 1 through
   STEP 14 as one block. Idempotent; safe against a live database. STEP 9
   ships commented out and stays that way unless STEP 0 was empty.
3. **Run STEP 15 alone** and read it: every account that had access yesterday
   must show `status = 'approved'`. If anyone who had access shows `pending`,
   fix it *before* deploying code.
4. **Then deploy the code.**

Why this order is the only safe one: the migration against the *old* code just
means new signups carry a `status` the old app ignores. The new code against
an *unmigrated* database means every `select … status` errors, `getSession`
fails closed by design, and **100% of users land on `/pending` with no way
out**. Rolling back the code fixes it; rolling forward the SQL also fixes it —
but neither is a first five minutes you want.

The migration's internal ordering hazards (why STEPs 1–3 are three
statements, why STEP 9 is conditional) are covered in
[DATA-MODEL.md](DATA-MODEL.md#the-approval-migration-steps-015).

---

## Environment variables

Five variables, all **required and validated at boot** by
[`src/lib/env.ts`](../club-dashboard-astro/src/lib/env.ts). A deploy missing
any of them throws at module load with a message naming the variable and what
breaks without it — deliberately, because the silent alternative was worse
(an unset `AUTH_SECRET` used to make `jose` sign every QR token with an empty
key, without erroring).

| Variable | Public? | Where it comes from | Used for |
|---|---|---|---|
| `PUBLIC_SUPABASE_URL` | yes | Supabase → Settings → API → Project URL | Both Supabase clients |
| `PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase → Settings → API → `anon public` | Session-aware auth client |
| `SUPABASE_SERVICE_ROLE_KEY` | **no** | Supabase → Settings → API → `service_role` | `supabaseAdmin` — bypasses RLS |
| `AUTH_SECRET` | **no** | `openssl rand -base64 48` | HS256 signing key for check-in QR tokens; < 32 chars logs a warning |
| `SITE_URL` | **no** | Canonical origin, scheme included | OAuth `redirectTo`, the URL inside QR codes, post-auth redirects, the CSRF origin check |

Details that matter:

- **In production, values are read from `process.env` at runtime** — the
  runtime truth on Vercel. Changing a variable in the dashboard takes effect
  on the next deployment/restart without a code change. In `astro dev` a
  compiled-out fallback reads `import.meta.env`, which is where Astro puts
  `.env` values locally.
- **Every value is `.trim()`ed** in one place (`env.ts`). Pasting into the
  Vercel UI routinely adds a trailing newline, and an untrimmed service-role
  key produces a 401 from PostgREST that looks nothing like "you have a
  newline in your env var". All five are covered — including `AUTH_SECRET`
  and `SITE_URL`, which the old app did not trim.
- **Empty or whitespace-only counts as missing.** A variable set to `""`
  fails the boot check.
- Set all five for **Production AND Preview** in Vercel → Project → Settings →
  Environment Variables.
- Do not "refactor" env access. Touching the bare `import.meta.env` object
  (spread, index, alias) makes Vite serialise **every** loaded variable —
  secrets included — into the server bundle, and quietly disables the boot
  check. The hazard and its history are documented in `env.ts` itself; if you
  edit that file, rebuild and grep `.vercel/output` for your `AUTH_SECRET`
  before pushing.

> **`SUPABASE_SERVICE_ROLE_KEY` grants full unrestricted database access.**
> Never `PUBLIC_`-prefix it, never reference it in a client `<script>`. If it
> leaks, rotate it in the Supabase dashboard immediately.

### Local `.env`

Lives at `club-dashboard-astro/.env` (not the repo root; gitignored):

```env
PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
AUTH_SECRET=<openssl rand -base64 48>
SITE_URL=http://localhost:3000
```

`SITE_URL` must match the port Astro serves on; `astro.config.mjs` pins 3000.

**Local dev talks to the real Supabase project.** No local database, no seed
script — everything you create locally is production data. Use a second
Supabase project for development if that matters.

---

## The SITE_URL cutover (pending)

`SITE_URL` on Vercel currently points at `https://mitty-business-club.vercel.app`,
which returns `DEPLOYMENT_NOT_FOUND`; production is served at
`https://mittybusinessclub.vercel.app`. Until the cutover, **sign-in is dead
in production**. Two things move together, one thing explicitly does not:

1. **Vercel** → set `SITE_URL` = `https://mittybusinessclub.vercel.app`.
2. **Supabase** → Authentication → URL Configuration: add
   `https://mittybusinessclub.vercel.app/api/auth/callback` to the redirect
   allow-list (and align Site URL). Skip this and the OAuth redirect silently
   bounces to the dead host — every sign-in fails with an opaque error.
3. **Google Cloud Console → unchanged.** Its authorized redirect URI is
   Supabase's own `https://<project-ref>.supabase.co/auth/v1/callback`, which
   does not contain your app's hostname. "Fixing" it there is the classic way
   to break sign-in while changing domains.

**Every outstanding QR code dies on cutover.** Check-in URLs embed `SITE_URL`,
so anything printed or sitting in a slide deck points at the dead host
(tokens stay signature-valid; the hostname inside them does not). With the
15-minute TTL this mostly self-heals — but re-open Present mode after the
cutover and re-project.

---

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Apply the schema — the three-pass procedure in
   [Deploy order](#deploy-order-sql-first-then-code).
3. **Authentication → Providers → Google** → enable, paste your Google OAuth
   client ID and secret.
4. **Authentication → URL Configuration** → add
   `https://<your-domain>/api/auth/callback` and
   `http://localhost:3000/api/auth/callback` to the redirect allow-list.
5. **Settings → API** → copy the project URL, anon key, and service-role key.

### Google OAuth client

Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID
(Web application):

- **Authorized redirect URI:** `https://<project-ref>.supabase.co/auth/v1/callback`

That is Supabase's callback, not your app's — Supabase brokers the exchange
and then redirects to your `/api/auth/callback`. Getting this wrong is the
most common first-time setup failure.

### Create the first admin

Signup yields `role='member', status='pending'`, and only an approved officer
can approve anyone — so the very first account is bootstrapped by hand after
its first sign-in:

```sql
update public.profiles
   set role = 'admin', status = 'approved'
 where email = 'you@example.com';
```

From then on `/members` handles approvals and promotions, and the last-admin
guard prevents the club from locking itself out again.

---

## 2. Local development

```bash
cd club-dashboard-astro
npm install
npm run dev
```

http://localhost:3000 redirects to `/login`.

| Command | Does |
|---|---|
| `npm run dev` | Astro dev server on :3000, HMR |
| `npm run build` | Production build → `.vercel/output` |
| `npm run preview` | Serve the built output locally |

No tests, no lint script; `npm run build` is the verification step. There is
no root `package.json`.

---

## 3. Vercel

The root [`vercel.json`](../vercel.json) does the whole job:

```json
{
  "buildCommand": "cd club-dashboard-astro && npm install && npm run build && mv .vercel/output ../.vercel/output",
  "installCommand": "echo 'skip root install'",
  "framework": null
}
```

- `installCommand` is a no-op and `framework: null` disables auto-detection —
  both are holdovers from when a Next.js app sat at the repo root, and they
  remain correct now that nothing does.
- `buildCommand` descends into the Astro app, builds, and **moves**
  `.vercel/output` up to the repo root where Vercel expects it.

Import the repo, add the five environment variables (Production and Preview),
deploy. No framework preset or root-directory override — setting one will
fight this config. The build emits a single `_render` function that handles
every route.

**Preview deployments:** the API's CSRF check accepts the request's own origin
precisely so previews work, but `SITE_URL` is a single static value — OAuth
from a preview URL will round-trip through Google and land on whatever origin
`SITE_URL` names. Sign in on production, or point a second Supabase project +
`SITE_URL` at the preview if you genuinely need preview auth.

---

## Auth failures this project has already hit

Baked into the source; if you find yourself "cleaning up" any of them, stop.

### `redirect_uri_mismatch` from Google

The Google client's redirect URI must be Supabase's
`https://<project-ref>.supabase.co/auth/v1/callback` — not your app's
`/api/auth/callback`.

### Sign-in bounces to `/login?error=auth-error`

Usually the PKCE code-verifier cookie wasn't readable at the callback. The fix
is `path: '/'` on every auth cookie in `createSupabaseServerClient` (commit
`2da6c8f`) — keep it. The redirect deliberately carries **no error detail**
(the old `&detail=` leaked provider internals into browser history); the real
cause is in **Vercel → Deployment → Functions → Logs**, where the callback
logs the full error with cookie values redacted.

Note `secure: true` is unconditional, including local dev. Browsers accept
secure cookies on `http://localhost`, so this works — but it will not work
over plain HTTP on any other host.

### Auth fails only in production, works locally

Historically a trailing newline on a pasted env var. All five values are now
trimmed centrally in `env.ts` (commit `dcabb3f` started this; the rebuild
finished it), so the more likely cause today is a variable missing from the
Vercel environment — which now fails the boot check loudly instead of
producing a weird 401 three requests later.

### Everyone lands on /pending after a deploy

The code shipped before the migration, or `getSession`'s profile read is
failing. Both fail closed to `/pending` **by design** — check the function log
for `[auth/getSession]` errors, and see
[Deploy order](#deploy-order-sql-first-then-code).

### QR codes stop working

Either `AUTH_SECRET` changed (rotating it invalidates every outstanding token
immediately — the desired behavior if one leaks) or the token simply aged out:
the TTL is 15 minutes, and Present mode on `/calendar` auto-refreshes the
projected code. A printed QR is stale by design.

---

## Rollback

No build-time migration step, so rolling back a **deployment** in the Vercel
dashboard is safe on its own — including rolling back to pre-approval code
after the migration ran (the old code ignores `status`; new signups pile up
as `pending` invisibly until you roll forward again).

**Schema** changes are applied by hand and are not rolled back with a deploy;
reverting one means writing the inverse SQL yourself. The migration was
designed so you shouldn't need to: re-running it is a no-op, and STEP 2 can
never re-approve an account an officer has since declined.
