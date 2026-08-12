# Architecture

How the Treasury Club Dashboard is put together, and the two or three
non-obvious decisions you need to know before changing anything.

---

## Stack

- **Astro 5**, `output: 'server'` — every route is server-rendered on each
  request. Nothing is statically prerendered.
- **`@astrojs/vercel`** adapter — the build emits `.vercel/output`, which Vercel
  serves as a single `_render` function (Fluid Compute, Node.js runtime).
- **Supabase** — Postgres, Auth (Google OAuth via PKCE), and Row Level Security
  policies.
- **No client framework.** No React, no Vue, no islands. Pages are `.astro` files
  with plain `<script>` blocks for interactivity, and one global stylesheet at
  `public/styles/global.css`. Keep it that way unless there's a reason not to.

Astro config is four lines ([`club-dashboard-astro/astro.config.mjs`](../club-dashboard-astro/astro.config.mjs)):

```js
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  server: { port: 3000 },
});
```

---

## Directory layout

```
club-dashboard-astro/
├── astro.config.mjs
├── public/styles/global.css        ← the entire stylesheet, hand-written
├── src/
│   ├── layouts/DashboardLayout.astro   ← shell: sidebar + topbar + <slot/>
│   ├── components/Sidebar.astro        ← nav links + sign-out
│   ├── lib/
│   │   ├── supabase.ts                 ← both Supabase clients (see below)
│   │   ├── auth.ts                     ← getSession / requireAuth
│   │   └── qrcode.ts                   ← signed check-in tokens (JWT + QR PNG)
│   └── pages/
│       ├── index.astro                 ← redirect gate
│       ├── login.astro   checkin.astro ← the only two public pages
│       ├── calendar.astro  attendance.astro
│       ├── members.astro   announcements.astro  finance.astro
│       └── api/                        ← JSON endpoints (see docs/API.md)
```

Path alias `@/*` → `src/*` is configured in `tsconfig.json`, but the code
currently uses relative imports throughout.

---

## Request flow

Two distinct paths, and it matters which one you're in:

### 1. Page render (the main path)

```
Browser
  → Astro page frontmatter
      → requireAuth(Astro.request, Astro.response.headers, Astro.redirect)
          → validates the Supabase session cookie
          → 401 → throws a redirect to /login
      → supabaseAdmin.from(...).select(...)     ← queries run RIGHT HERE
  → HTML rendered with the data inlined
```

Pages talk to Postgres **directly in their frontmatter**. They do not call the
project's own `/api/*` endpoints to read data. `calendar.astro`,
`attendance.astro`, `members.astro`, `announcements.astro`, and `finance.astro`
all import `supabaseAdmin` and query it themselves.

### 2. Mutations (and only mutations)

```
Browser <script> fetch('/api/…', { method: 'POST' | 'PATCH' | 'DELETE' })
  → src/pages/api/**/*.ts
      → getSession(request, responseHeaders)
      → role check: 401 if no session, 403 if wrong role
      → supabaseAdmin mutation
  → JSON response
  → page calls location.reload()
```

**Consequence:** the read-only `GET` endpoints — `/api/finance`,
`/api/attendance`, `/api/members`, `/api/events`, `/api/announcements` — have no
callers in this repo. They're a parallel JSON API surface kept for external
consumers or future use. Two of them are unauthenticated; see
[KNOWN-GAPS.md](KNOWN-GAPS.md#unauthenticated-read-endpoints).

---

## The two Supabase clients

Both live in [`src/lib/supabase.ts`](../club-dashboard-astro/src/lib/supabase.ts).
Picking the wrong one is the easiest way to break this app.

### `supabaseAdmin` — service role, bypasses RLS

```ts
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
```

A module-level singleton built with `SUPABASE_SERVICE_ROLE_KEY`. **Every data
read and write in the app goes through this client.** It ignores Row Level
Security completely.

Server-only. If this key ever reaches the browser, the entire database is
readable and writable by anyone.

### `createSupabaseServerClient(request, responseHeaders)` — anon key, session-aware

```ts
createServerClient(supabaseUrl, supabaseAnonKey, { cookies: { getAll, setAll } })
```

A per-request client used **only for auth**: the OAuth redirect, the PKCE code
exchange, session validation, and sign-out. It reads cookies off the incoming
`Request` and appends `Set-Cookie` headers to the `Headers` object you hand it.

That second argument is the whole reason the function takes a mutable `Headers`:
Supabase refreshes sessions transparently, and the refreshed cookie has to get
back to the browser. In a page, always pass `Astro.response.headers`.

---

## RLS is defined but not enforced

`supabase-schema.sql` defines a complete set of Row Level Security policies —
members read their own transactions, officers read all, and so on. Those policies
are **live in the database but inert for this application**, because every query
runs as service role.

Authorization in this app is enforced in application code:

- **Pages** call `requireAuth(...)`, then branch on
  `['admin','treasurer'].includes(user.role)` to decide what to render.
- **API endpoints** re-check the session and role on every mutating request.

This is a deliberate trade — it dodged a class of "RLS silently returned zero
rows" bugs during development (see the `getSession` comment in `lib/auth.ts`).
But it means:

> **Any new query you write is unrestricted by default.** If you add an endpoint
> and forget the role check, there is no second line of defence. The RLS policies
> will not save you.

The policies still matter for anything that talks to Supabase with the anon key —
future direct-from-browser queries, the Supabase dashboard under a user token,
or a third-party client. Keep them accurate.

---

## Authentication

Google OAuth through Supabase Auth, PKCE flow.

```
/login
  → user clicks "Sign in with Google"
  → GET /api/auth/signin
      supabase.auth.signInWithOAuth({ provider: 'google',
                                      redirectTo: `${SITE_URL}/api/auth/callback`,
                                      queryParams: { access_type: 'offline', prompt: 'consent' } })
      → sets the PKCE code-verifier cookie
      → 302 to Google
  → Google → 302 back to /api/auth/callback?code=…
  → GET /api/auth/callback
      supabase.auth.exchangeCodeForSession(code)   ← needs that verifier cookie
      → upsert public.profiles row if missing (role defaults to 'member')
      → 302 to /calendar
```

Two hard-won details, both encoded as comments in the source — don't undo them:

1. **`path: '/'` on every auth cookie.** The PKCE code-verifier is set during
   `/api/auth/signin` but has to be readable at `/api/auth/callback`. Without an
   explicit root path it scopes to the signin path and the exchange fails with an
   opaque error. Fixed in commit `2da6c8f`.

2. **`.trim()` on every env var.** Pasting keys into the Vercel dashboard
   commonly carries a trailing newline, which produces confusing auth failures
   rather than an obvious parse error. Fixed in commit `dcabb3f`.

### Profile creation, twice over

`supabase-schema.sql` installs an `on_auth_user_created` trigger that inserts a
`public.profiles` row for every new `auth.users` row. The callback *also* checks
for a profile and creates one if it's missing (commit `37e9246`), because the
trigger proved unreliable in practice. The redundancy is intentional — the
callback uses `supabaseAdmin` so RLS can't block the check.

### Session reads

[`lib/auth.ts`](../club-dashboard-astro/src/lib/auth.ts) exposes two functions:

- **`getSession(request, responseHeaders)`** → `SessionUser | null`.
  Calls `supabase.auth.getUser()` — which validates the JWT against Supabase
  rather than trusting the cookie's contents, unlike `getSession()`. Then fetches
  `name` and `role` from `profiles` via `supabaseAdmin`. Role defaults to
  `'member'` if the profile row is missing.
- **`requireAuth(request, responseHeaders, redirect)`** → `SessionUser`, or
  **throws** an Astro redirect to `/login`. Use this in page frontmatter; use
  `getSession` in API routes where you want to return a 401 instead.

---

## Roles and authorization

Three roles, enforced by `check` constraint on `profiles.role`:

| Role | Granted by | Can |
|---|---|---|
| `member` | default on signup | View everything; submit their own transactions; check in to events |
| `treasurer` | admin promotion | Everything a member can, plus create/cancel events, post/delete announcements, approve/reject/delete transactions, create budgets |
| `admin` | manual DB edit, or promotion by another admin | Everything a treasurer can, plus **change other members' roles** |

"Officer" is shorthand for `admin` or `treasurer` and appears throughout the code
as `['admin','treasurer'].includes(user.role)`. `admin` and `treasurer` have
identical permissions everywhere **except** `PATCH /api/members/:id`, which is
admin-only.

The first admin has to be set by hand in the Supabase table editor — signup
always yields `member`.

---

## QR check-in

[`lib/qrcode.ts`](../club-dashboard-astro/src/lib/qrcode.ts) implements a
stateless check-in token using `jose`:

```
generateEventQR(eventId, siteUrl)
  → HS256 JWT { event_id }, 4-hour expiry, signed with AUTH_SECRET
  → embed in `${siteUrl}/checkin?token=<jwt>`
  → render as a PNG data URL
```

An officer opens an event on `/calendar` and displays the QR. A member scans it,
lands on the public `/checkin` page (which decodes the token server-side to show
the event title), and taps to check in. `POST /api/attendance/checkin` verifies
the signature and expiry, resolves the member from the session, and inserts an
`attendance` row with `method: 'qr'`.

Duplicate check-ins are blocked twice: an explicit lookup returning `409 Already
checked in`, and the `attendance_event_member_unique` constraint on
`(event_id, member_id)` as backstop.

`AUTH_SECRET` is the signing key. Rotating it invalidates every outstanding QR
code immediately — which is the desired behaviour if one leaks.

**The token is a bearer credential.** Anyone who photographs the projected QR can
check in for the next four hours. That's an accepted trade for a club dashboard;
see [KNOWN-GAPS.md](KNOWN-GAPS.md#qr-check-in-can-be-done-on-anyones-behalf) for
the sharper version of this problem.

---

## Styling

One file: `public/styles/global.css`, linked from `DashboardLayout.astro` and
from the two standalone pages (`login.astro`, `checkin.astro`). Plain CSS with
BEM-ish class names — no Tailwind, no preprocessor, no build step.

`DashboardLayout.astro` takes `{ title, subtitle, user }` and renders the sidebar,
a topbar with the user's role badge, and a `<slot/>`. The subtitle defaults to
`'Spring 2026 · Officer View'` — a hardcoded term label worth parameterising if
this outlives the semester.

`Sidebar.astro` holds the nav array (Calendar, Attendance, Members,
Announcements, Finance) with inline SVG icons, and highlights the active item via
`currentPath.startsWith(item.href)`. Note it renders the same five links for
every role — officer-only *actions* are hidden per-page, not per-nav-item.
