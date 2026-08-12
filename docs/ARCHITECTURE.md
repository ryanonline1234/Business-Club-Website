# Architecture

How the portal is put together, and the non-obvious decisions you need to know
before changing anything. The single most important one: **authorization lives
in `src/lib/auth.ts` and nowhere else.** Every page and every API route starts
with one of its guards. Copy-pasted role checks are exactly how two endpoints
ended up unauthenticated in the old app — do not hand-roll a new one.

---

## Stack

- **Astro 5**, `output: 'server'` — every route is server-rendered on each
  request. Nothing is statically prerendered.
- **`@astrojs/vercel`** adapter — the build emits `.vercel/output`, which Vercel
  serves as a single `_render` function (Node.js runtime).
- **Supabase** — Postgres, Auth (Google OAuth via PKCE), and Row Level Security
  policies.
- **No client framework.** No React, no islands. Pages are `.astro` files with
  plain `<script>` blocks, one global stylesheet at `public/styles/global.css`.
- **No external runtime resources.** Fonts are self-hosted via `@fontsource`
  packages (Barlow Condensed, Libre Baskerville), bundled at build time. No
  CDNs, no Google Fonts URLs, no remote images.

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
│   ├── middleware.ts                   ← converts thrown redirects (see below)
│   ├── layouts/DashboardLayout.astro   ← shell: topbar + nav + <slot/> + thumb bar
│   ├── components/
│   │   ├── TopRail.astro               ← desktop nav (removed under 700px)
│   │   └── ThumbBar.astro              ← fixed phone nav (the only nav under 700px)
│   ├── lib/
│   │   ├── env.ts                      ← boot-time env validation; isSchoolEmail
│   │   ├── supabase.ts                 ← both Supabase clients
│   │   ├── auth.ts                     ← ALL guards, page and API
│   │   ├── next-redirect.ts            ← the ?next= carrier cookie + open-redirect check
│   │   └── qrcode.ts                   ← signed check-in tokens (jose JWT + QR PNG)
│   └── pages/
│       ├── index.astro                 ← home dashboard
│       ├── login.astro  pending.astro  checkin.astro   ← standalone (no layout)
│       ├── calendar.astro  attendance.astro
│       ├── members.astro   announcements.astro
│       └── api/                        ← JSON endpoints (see docs/API.md)
```

---

## Env validation at boot

[`src/lib/env.ts`](../club-dashboard-astro/src/lib/env.ts) validates all five
required variables **once, at module load**, and throws if any is missing or
whitespace-only. `lib/supabase.ts` and `lib/qrcode.ts` both import it, so any
route that can reach the database or mint a token has already run the check.

Why it exists: `new TextEncoder().encode(undefined)` is a zero-length key, and
`jose` will happily sign HS256 with it **without throwing** — an unset
`AUTH_SECRET` used to mean every check-in token was silently forgeable. A
deploy that cannot sign tokens must die at boot instead.

Two rules encoded in that file, both load-bearing:

1. **Production reads `process.env` only.** That is the runtime truth on
   Vercel; reading it is what makes a deploy with a missing runtime variable
   actually fail. A dev-only fallback reads `import.meta.env` behind
   `import.meta.env.DEV` (which Vite compiles to `false` and Rollup removes),
   because `astro dev` loads `.env` into `import.meta.env` only.
2. **Never touch the bare `import.meta.env` object** — no
   `import.meta.env[key]`, no spread, no aliasing. Vite compiles a bare
   reference into an object literal containing **every loaded variable as a
   string**, which serialises the service-role key and `AUTH_SECRET` into the
   server bundle. This was real; it was verified in `.vercel/output`.

Every value is `.trim()`ed (Vercel paste newlines), `SITE_URL` loses trailing
slashes and is parsed to `SITE_ORIGIN` for the CSRF check, and
`isSchoolEmail()` — the **only** TypeScript definition of the school-domain
rule — lives here, mirrored by `public.is_school_email()` in SQL.

---

## Request flow

Two distinct paths, and it matters which one you're in:

### 1. Page render (the main path)

```
Browser
  → Astro page frontmatter
      → requireApproved(Astro.request, Astro.response.headers, Astro.redirect)
          → no session   → THROWS a redirect to /login
          → not approved → THROWS a redirect to /pending
      → supabaseAdmin.from(...).select(...)     ← queries run RIGHT HERE
  → HTML rendered with the data inlined (Astro escapes by default)
```

Pages talk to Postgres **directly in their frontmatter** via `supabaseAdmin`.
They do not call the project's own `/api/*` endpoints to read data — every
`GET`-list endpoint from the old app was deleted.

The guards **throw** their redirect. Astro 5 only honours a *returned*
Response from frontmatter, so [`src/middleware.ts`](../club-dashboard-astro/src/middleware.ts)
catches any thrown `Response` and returns it. Without that middleware a
signed-out visitor gets the 500 page instead of `/login`. Don't remove it.

### 2. Mutations (and only mutations)

```
Browser <script> fetch('/api/…', { method: 'POST' | 'PATCH' | 'DELETE' })
  → src/pages/api/**/*.ts
      → const guard = await apiRequireOfficer(request, responseHeaders)
        if (!guard.ok) return guard.response       ← 401/403 already built
      → validate body → supabaseAdmin mutation
  → JSON via apiJson(status, body, responseHeaders)
  → page calls location.reload()
```

Client `<script>` blocks submit forms, fetch, toggle small state, and reload.
**They never render data strings into DOM HTML** — see
[Rendering and XSS](#rendering-and-xss).

---

## The guard layer

All of [`src/lib/auth.ts`](../club-dashboard-astro/src/lib/auth.ts). Session
resolution **fails closed**: if the `profiles` row is missing or the query
errors, the caller gets `role: 'member'`, `status: 'pending'` — never access.
`SessionUser.profileState` (`'ok' | 'missing' | 'error'`) lets `/pending`
distinguish "a database blip parked you here" from "you are genuinely waiting".

| Guard | For | Behavior |
|---|---|---|
| `requireSession` | `/pending` only | Throws redirect to `/login` if signed out |
| `requireApproved` | every dashboard page | …plus throws to `/pending` unless `status='approved'` |
| `requireOfficer` | (available, unused today) | …plus throws to `/` unless approved admin/treasurer |
| `apiRequireApproved` | member-facing endpoints | Returns `{ok:false, response}` — 403 `Invalid origin` (CSRF), 401, or 403 `Account pending approval` |
| `apiRequireOfficer` | officer endpoints | …plus 403 `Forbidden` unless approved admin/treasurer |
| `apiRequireAdmin` | `PATCH /api/members/:id` | …plus 403 `Forbidden` unless approved admin |

Derived flags: `isApproved` = `status === 'approved'`; `isOfficer` and
`isAdmin` **both require approved** — a pending admin is nobody.

Page guards take `(Astro.request, Astro.response.headers, Astro.redirect)` and
must be **the first statement of frontmatter**. API guards take
`(request, responseHeaders)` where `responseHeaders` is a `Headers` you create
and thread through every response — Supabase appends refreshed session cookies
to it, and `apiJson()` copies them out without corrupting multiple
`Set-Cookie` values (never rebuild headers with `Headers.forEach`, which folds
them into one comma-joined string).

### CSRF

`apiRequire*` runs an origin check on every mutating method (`POST`, `PATCH`,
`PUT`, `DELETE`): `Sec-Fetch-Site` and `Origin` are each conclusive, matched
against `SITE_ORIGIN` *or* the origin the request actually arrived on (which
keeps Vercel preview deployments working). Neither header present (curl,
server-to-server) passes — this is defence-in-depth on top of the session
cookie's `SameSite=lax`, not the authentication boundary.
`checkSafeNavigation` applies the same test to `GET /api/auth/signout`, which
changes state on a GET and would otherwise be triggerable by a cross-site
`<img src>` (no `Origin` header — only `Sec-Fetch-Site` catches it).

---

## The two Supabase clients

Both live in [`src/lib/supabase.ts`](../club-dashboard-astro/src/lib/supabase.ts).

### `supabaseAdmin` — service role, bypasses RLS

Module-level singleton. **Every data read and write in the app goes through
it.** Because it ignores RLS, the guard above each query is the only access
control — there is no second line of defence. Server-only, obviously.

### `createSupabaseServerClient(request, responseHeaders)` — anon key, session-aware

Per-request client used **only for auth**: OAuth redirect, PKCE exchange,
`getUser()` validation, sign-out. It reads cookies off the `Request` and
appends `Set-Cookie` to the `Headers` you hand it. Cookies are forced to
`path: '/'`, `secure`, `sameSite: 'lax'`, `httpOnly` — the `path: '/'` is why
the PKCE code-verifier set during `/api/auth/signin` is readable at
`/api/auth/callback` (commit `2da6c8f`; sign-in breaks without it).

---

## Authentication

Google OAuth through Supabase Auth, PKCE flow. Four gates; gate 1 is a hint,
2–4 are enforcement:

1. **Google's account chooser** — `hd: '*'` on `signInWithOAuth` hides
   personal accounts in the chooser. Client-controllable, never trusted.
2. **Domain gate in the callback** ([`api/auth/callback.ts`](../club-dashboard-astro/src/pages/api/auth/callback.ts)) —
   `isSchoolEmail()` decides. Rejection order is load-bearing: `signOut()`
   first (so the session-clearing cookies travel with the redirect), then
   `admin.deleteUser()` (so a student who picked the wrong account gets a
   clean retry — this needs the `on delete cascade` from the migration).
   **The grandfather clause:** an existing profile with `status='approved'`
   signs in regardless of domain — without it the club's only admin, on a
   personal address, is locked out the moment the rule ships.
3. **The session layer** — the guards above, on every route.
4. **Page level** — the only public routes are `/login`, `/checkin`, and
   `/api/auth/*`; `/pending` needs a session but not approval.

Error redirects carry a **fixed code only** (`?error=domain | auth-error`) —
never provider error text, which used to leak into browser history and
referrer headers. Detail goes to `console.error` (the Vercel function log).
`/login` maps codes to copy and renders nothing for unknown keys.

### Profile creation — and the one write you must never make

The `on_auth_user_created` trigger creates the `profiles` row, but it has
proven unreliable, so the callback independently checks and creates it
(`on conflict` handled). Both paths obey the same rule:

> **NEVER write `role` or `status` on a returning login.** An upsert with
> `role: 'member', status: 'pending'` silently demotes every officer and
> un-approves every member the next time they sign in, and presents as "the
> approval system randomly broke". Missing row → insert `{id, email, name}`
> only (column defaults own the rest). Existing row → update `email`/`name`
> only, ever.

### The `?next=` round trip

A member who scans a QR while signed out must come back to the scan.
[`lib/next-redirect.ts`](../club-dashboard-astro/src/lib/next-redirect.ts)
carries the destination through Google in a 10-minute httpOnly cookie
(`mbc-next`), set by `/api/auth/signin?next=…` and consumed once by the
callback. `safeNextPath()` is the open-redirect defence: same-origin
root-relative paths only, `//` and `/\` rejected, auth routes excluded.
Pending users always land on `/pending` regardless of `next`.

---

## Roles and authorization

| Role | Granted by | Can |
|---|---|---|
| `member` | default on signup (after approval) | See everything approved members see; check in to events |
| `treasurer` | admin promotion | …plus create/cancel events, post/delete announcements, present QR codes, **approve/decline accounts** |
| `admin` | first one by SQL, then promotion | …plus change member roles |

Approval (`PATCH /api/members/:id/status`) is deliberately officer-wide —
treasurers run meetings, and letting members in is part of running a meeting.
Role changes (`PATCH /api/members/:id`) are admin-only, so a treasurer cannot
mint an admin. Both endpoints refuse the write that would leave zero approved
admins (the last-admin guard), and an officer can never rule on their own
account. See [API.md](API.md#members).

---

## QR check-in

[`lib/qrcode.ts`](../club-dashboard-astro/src/lib/qrcode.ts): an HS256 JWT
`{ event_id }` with issuer/audience/`jti`, signed with `AUTH_SECRET`,
**15-minute TTL**, embedded in `${SITE_URL}/checkin?token=…` and rendered as a
PNG data URL. Verification pins `algorithms: ['HS256']` so an `alg: none`
token can never pass.

```
Officer on /calendar → Present mode → GET /api/events/:id/qr   (officer-gated)
  → full-bleed projected QR, silently re-fetched ~3 min before expiry
Member scans → /checkin (public) → signs in if needed (?next= round trip)
  → taps Check in → POST /api/attendance/checkin { qr_token }
  → identity comes from the SESSION, never the body
  → event must exist, be 'active', and be inside its check-in window
```

The check-in window is `start_time − 30 min` → `end_time + 2 h` (or
`start_time + 4 h` when there's no end). A valid token is *not* enough on its
own — a token stays signature-valid even if the event is cancelled a minute
after projection, which is why the endpoint re-checks the event. Duplicates
get a clean 409 from an explicit lookup, with the
`attendance_event_member_unique` constraint as the race backstop.

**The token is still a bearer credential.** Anyone in the room who photographs
the projected code can check in, or forward it to an absent friend, for up to
15 minutes. Accepted trade — see
[KNOWN-GAPS.md](KNOWN-GAPS.md#the-qr-token-is-a-shared-bearer-secret).

Rotating `AUTH_SECRET` invalidates every outstanding token immediately.

---

## Rendering and XSS

**All data is rendered server-side in Astro templates**, which escape by
default. The previous version of this app rebuilt feeds client-side with
`innerHTML` — a stored-XSS hole through which a treasurer could script their
way to admin in an admin's browser. The rule now:

- Never interpolate data into `innerHTML` / `insertAdjacentHTML` / `outerHTML`.
- Client JS may set `textContent` on existing elements and, if it must create
  elements, `document.createElement` + `textContent` only.
- `/checkin` additionally charset-gates the token
  (`/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`) before it reaches an
  inline `define:vars` script, so no `<`/`>` can ever appear there.

---

## Timezones

The club is in `America/Los_Angeles`; the server runs in UTC. **Every**
day-bucketing or "today" decision computes Pacific-local date keys —
`toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })` for
`YYYY-MM-DD` — never the server's local date. The old calendar bucketed on the
UTC date and rendered every evening event on the following day. Human-facing
dates and times are likewise formatted with an explicit `timeZone` (except on
`/checkin`, where the member's phone is in the room and the phone's zone is
correct).

---

## Styling and the design system

One hand-written stylesheet, `public/styles/global.css`. The system in short:
warm bone paper (never white), antique gold fills edged in darker gold,
athletic gold reserved as the highlighter for things happening *now*,
moss/clay for positive/destructive, structure from hairlines and space rather
than cards, radii only 4px and full-round, two box-shadows total, no
gradients, a 12–48px type scale with oversized serif date numerals as the
brand mark, `light-dark()` variable pairs for theming (no toggle — the OS
decides), and 48px minimum touch targets.

Navigation is responsive by **replacement**, not squeezing: under 700px the
top rail is removed entirely and the fixed `ThumbBar` (with
`env(safe-area-inset-bottom)` clearance) becomes the navigation, check-in at
the right edge where a thumb rests.

`DashboardLayout.astro` takes `{ title, subtitle?, user }` and derives the
default subtitle from the current Pacific school term (Fall/Spring/Summer +
year) — the hardcoded "Spring 2026" label is gone. `/login`, `/pending`, and
`/checkin` are standalone pages that link the same stylesheet.
