# Orientation — read before touching anything

**This is an Astro 5 app.** All work happens in `club-dashboard-astro/`. There
is no other application in this repo and no root `package.json`.

A legacy Next.js 16 app used to sit at the repo root. It was never deployed —
`vercel.json` always skipped it — and it was deleted in the rebuild. Any
reference to `next.config.ts`, `src/app/`, NextAuth, or `NEXT_PUBLIC_*`
environment variables is stale documentation, not code that exists.

Before writing code, read:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — request flow, the guard
  layer, env validation, the two Supabase clients
- [`docs/API.md`](docs/API.md) — every endpoint with its guard and contract
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) — schema, the approval migration,
  RLS
- [`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md) — accepted trades and open items;
  check here before "fixing" something that looks broken

## Invariants — don't break these

1. **Every route starts with a guard from `src/lib/auth.ts`, and nowhere
   else.** Pages: `requireApproved(Astro.request, Astro.response.headers,
   Astro.redirect)` as the first frontmatter statement (`requireSession` for
   `/pending` only). API routes: `apiRequireApproved` / `apiRequireOfficer` /
   `apiRequireAdmin`, then `if (!guard.ok) return guard.response`. Never
   hand-roll a role check — copy-pasted checks are how endpoints ended up
   unauthenticated before. `supabaseAdmin` bypasses RLS, so the guard is the
   **only** access control on a route.
2. **Env goes through `src/lib/env.ts`, full stop.** It validates all five
   variables at boot, trims them, and is the only home of `isSchoolEmail()`.
   Never read `import.meta.env` in app code, and **never touch the bare
   `import.meta.env` object** (index, spread, alias) — Vite serialises every
   loaded variable, secrets included, into the server bundle and silently
   defeats the boot check. The hazard is documented in `env.ts`; it was real.
3. **No data in `innerHTML`, ever.** All data renders server-side in Astro
   templates (escaped by default). Client scripts submit forms, fetch, toggle
   state, and `location.reload()` — they never build HTML from data strings
   (`insertAdjacentHTML` and `outerHTML` included). If a script must create
   elements: `document.createElement` + `textContent` only. The previous app's
   `innerHTML` feed was a stored-XSS hole that allowed treasurer→admin
   escalation.
4. **Never write `role` or `status` on a returning login.** In
   `api/auth/callback.ts`: missing profile → insert `{ id, email, name }` only
   (column defaults own role/status); existing profile → update `email`/`name`
   only. The tempting upsert with `role: 'member', status: 'pending'` silently
   demotes every officer and un-approves every member on their next sign-in.
5. **Migration sequencing: SQL first, then code.** The app selects
   `profiles.status`; code deployed before `supabase-schema.sql` strands every
   user on `/pending` (fail-closed by design). Within the file: run STEP 0
   alone and read it first, STEPs 1–3 stay three separate statements, STEP 9
   stays commented out unless STEP 0 returned zero rows. Schema changes go in
   `supabase-schema.sql`, applied by hand, kept idempotent.
6. **Keep the auth-cookie flags in `lib/supabase.ts`** — `path: '/'` (the PKCE
   verifier must be readable at `/api/auth/callback`; sign-in breaks without
   it, commit `2da6c8f`), `httpOnly`, `secure`, `sameSite: 'lax'`.
7. **Thread response headers.** Pages pass `Astro.response.headers` to the
   guards; API routes create one `Headers`, pass it to the guard, and send
   every response through `apiJson(status, body, responseHeaders)` — that is
   what carries refreshed session cookies without corrupting multiple
   `Set-Cookie` values.
8. **Page redirects are root-relative** (`/login`, `/pending`, `/`) — never
   `SITE_URL`-prefixed in page code. `?next=` values go through
   `safeNextPath()` (lib/next-redirect.ts), never raw into a redirect.
9. **Day-bucketing is Pacific-local.** The club is in `America/Los_Angeles`;
   the server runs in UTC. Any "today" or day-grouping logic uses
   `toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })` keys —
   bucketing on the UTC date put evening events on the wrong day once already.
10. **No client framework, no external runtime resources.** Plain `.astro`
    files, inline `<script>`, one stylesheet at `public/styles/global.css`,
    fonts self-hosted via the `@fontsource` packages. No React, no Tailwind,
    no CDN URLs, no Google Fonts.

## Verifying

There are no tests and no lint script. The check before declaring done:

```bash
cd club-dashboard-astro && npm run build
```
