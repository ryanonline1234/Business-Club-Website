# Deployment & Setup

Getting the Astro app running locally and on Vercel, plus the auth failures this
project has already hit — check that section first when login breaks.

---

## Environment variables

Five variables, all required. In Astro, `PUBLIC_`-prefixed vars are exposed to
the browser and everything else is server-only.

| Variable | Public? | Where it comes from | Used for |
|---|---|---|---|
| `PUBLIC_SUPABASE_URL` | yes | Supabase → Settings → API → Project URL | Both Supabase clients |
| `PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase → Settings → API → `anon public` | Session-aware auth client |
| `SUPABASE_SERVICE_ROLE_KEY` | **no** | Supabase → Settings → API → `service_role` | `supabaseAdmin` — bypasses RLS |
| `AUTH_SECRET` | **no** | Generate: `openssl rand -base64 32` | HS256 signing key for check-in QR tokens |
| `SITE_URL` | **no** | Your origin, no trailing slash | OAuth `redirectTo`, all post-auth redirects |

> **`SUPABASE_SERVICE_ROLE_KEY` grants full unrestricted database access.** It
> must never be prefixed with `PUBLIC_` and never referenced in a client-side
> `<script>` block. If it leaks, rotate it in the Supabase dashboard immediately.

`club-dashboard-astro/.gitignore` excludes `.env`, and the root `.gitignore`
excludes `.env*`. Neither is tracked by git — verified with `git ls-files`.

### Local `.env`

Lives at `club-dashboard-astro/.env` (not the repo root):

```env
PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
AUTH_SECRET=<openssl rand -base64 32>
SITE_URL=http://localhost:3000
```

`SITE_URL` must match the port Astro actually serves on. `astro.config.mjs` pins
it to `3000`.

### On Vercel

Set all five in **Project → Settings → Environment Variables**, with
`SITE_URL` pointing at the production domain (`https://your-app.vercel.app`).

`src/lib/supabase.ts` calls `.trim()` on all three Supabase values precisely
because pasting into the Vercel UI so often carries a trailing newline. Don't
remove those `.trim()` calls.

**Preview deployments are a problem.** `SITE_URL` is a single static value, so
every preview deployment sends OAuth callbacks to whatever origin it names —
production, most likely. Preview-branch sign-in will not work correctly without
either per-environment `SITE_URL` values or deriving the origin from the request.

---

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste all of [`supabase-schema.sql`](../supabase-schema.sql)
   → Run. It's idempotent apart from the `create trigger` statement, which errors
   on re-run if the trigger already exists (harmless — everything before it
   applied).
3. **Authentication → Providers → Google** → enable it and paste in your Google
   OAuth client ID and secret.
4. **Authentication → URL Configuration** → add
   `https://<your-domain>/api/auth/callback` and
   `http://localhost:3000/api/auth/callback` to the redirect allow-list.
5. **Settings → API** → copy the project URL, anon key, and service role key.

### Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com) → APIs & Services →
Credentials → **OAuth 2.0 Client ID** (type: Web application):

- **Authorized redirect URI:**
  `https://<project-ref>.supabase.co/auth/v1/callback`

That's Supabase's callback, not your app's — Supabase brokers the exchange and
then redirects to your `/api/auth/callback`. Getting this wrong is the most
common first-time setup failure.

### Create the first admin

Signup always assigns `role: 'member'`, and only an `admin` can promote anyone.
Bootstrap by hand after your first sign-in:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

From then on, `/members` handles promotions.

---

## 2. Local development

```bash
cd club-dashboard-astro
npm install
npm run dev
```

http://localhost:3000 redirects to `/login`.

Local dev talks to the **real** Supabase project — there's no local Supabase, no
seed script, and no separate dev database. Anything you create locally is
production data. Consider a second Supabase project for development if that
matters to you.

| Command | Does |
|---|---|
| `npm run dev` | Astro dev server on :3000, HMR |
| `npm run build` | Production build → `.vercel/output` |
| `npm run preview` | Serve the built output locally |

No tests, no lint script. `npm run lint` at the repo root lints the dead Next.js
app and tells you nothing about the deployed one.

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

Reading it left to right:

- `installCommand` is a no-op so Vercel never installs the root Next.js
  dependencies.
- `framework: null` disables framework auto-detection, which would otherwise see
  the root `next.config.ts` and try to build the wrong app.
- `buildCommand` descends into the Astro app, installs, builds, then **moves**
  `.vercel/output` up to the repo root where Vercel expects to find it.

Import the repo into Vercel, add the five environment variables, deploy. No
project-level framework preset or root-directory override is needed — and setting
one will likely conflict with this config.

The build emits a single `_render` serverless function that handles every route.

---

## Auth failures this project has already hit

Four fixes are baked into the source. If you find yourself "cleaning up" any of
them, read this first.

### `redirect_uri_mismatch` from Google

The Google OAuth client's authorized redirect URI must be
`https://<project-ref>.supabase.co/auth/v1/callback` — Supabase's endpoint, not
your app's `/api/auth/callback`.

### Sign-in bounces back to `/login?error=auth-error`

The PKCE code-verifier cookie wasn't readable at the callback. Fixed in commit
`2da6c8f` by setting `path: '/'` on every auth cookie in
`createSupabaseServerClient`:

```ts
serializeCookieHeader(name, value, {
  ...options,
  path: '/',        // ← without this the verifier scopes to /api/auth/signin
  secure: true,
  sameSite: 'lax',
  httpOnly: true,
})
```

The callback appends `&detail=<supabase error message>` to that redirect and logs
the full error (with cookies redacted) to the Vercel function log — check
**Vercel → Deployment → Functions → Logs** for the real cause.

Note `secure: true` is unconditional, including in local dev. Modern browsers
accept secure cookies on `http://localhost`, so this works — but it will not work
over plain HTTP on any other host.

### Auth fails only in production, works locally

Almost always a trailing newline on a pasted env var. Commit `dcabb3f` added
`.trim()` to the three Supabase values in `src/lib/supabase.ts`. `AUTH_SECRET`
and `SITE_URL` are **not** trimmed — a stray newline in either will break QR
tokens or produce malformed redirect URLs respectively.

### Signed in, but the app behaves as if you have no profile

The `on_auth_user_created` trigger didn't fire. Commit `37e9246` made
`/api/auth/callback` check for the profile with `supabaseAdmin` and create it if
missing. If a user is somehow still profile-less, `getSession` degrades to
`role: 'member'` rather than failing.

### QR codes stop working after a deploy

`AUTH_SECRET` changed. Tokens are signed with it and carry a 4-hour expiry, so
rotating the secret invalidates every outstanding QR immediately. Regenerate from
`/calendar`.

---

## Rollback

`vercel.json` is the only deploy-shaped config, and there's no build-time
database migration step — so rolling back a deployment in the Vercel dashboard is
safe on its own. Schema changes are applied by hand and are **not** rolled back
with it; reverting a schema change means writing the inverse SQL yourself.
