# Orientation — read before touching anything

**This is an Astro 5 app.** All work happens in `club-dashboard-astro/`. There is
no other application in this repo.

A legacy Next.js 16 app used to sit at the repo root. It was never deployed —
`vercel.json` always skipped it — and it was deleted in the rebuild. If you find
a reference to `next.config.ts`, `src/app/`, NextAuth, or `NEXT_PUBLIC_*`
environment variables anywhere, it is stale documentation, not code that exists.

Before writing code, read:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — request flow, the two Supabase
  clients, the auth model
- [`docs/API.md`](docs/API.md) — every endpoint with its auth requirement
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) — schema, constraints, RLS
- [`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md) — what's half-built; check here
  before "fixing" something that looks broken

## Invariants — don't break these

1. **`supabaseAdmin` bypasses RLS.** Every query in the app uses it, so the RLS
   policies in `supabase-schema.sql` do not gate this application. **Any new
   endpoint must check the session and role itself** — there is no second line of
   defence. Pattern: `getSession(...)` → 401 if null → 403 unless
   `['admin','treasurer'].includes(session.role)`.
2. **Never expose `SUPABASE_SERVICE_ROLE_KEY` or `AUTH_SECRET` to the client.**
   Only `PUBLIC_`-prefixed vars may appear in a client `<script>` block.
3. **Keep `path: '/'` on auth cookies** in `lib/supabase.ts`. Without it the PKCE
   code-verifier isn't readable at `/api/auth/callback` and sign-in breaks
   (commit `2da6c8f`).
4. **Keep the `.trim()` calls on env vars** in `lib/supabase.ts`. Pasted Vercel
   values carry trailing newlines (commit `dcabb3f`).
5. **Pass `Astro.response.headers` into `getSession`/`requireAuth`.** Supabase
   appends refreshed session cookies to it; a fresh `Headers()` in a page drops
   them.
6. **No client framework.** Plain `.astro` files, inline `<script>`, one
   stylesheet at `public/styles/global.css`. Don't introduce React, Tailwind, or
   a component library without asking.
7. **Schema changes go in `supabase-schema.sql`** and are applied by hand in the
   Supabase SQL Editor. There are no migrations. Keep the file idempotent.

## Verifying

There are no tests and no lint script for the Astro app. The check before
declaring done is:

```bash
cd club-dashboard-astro && npm run build
```

There is no root `package.json` any more — every npm command runs from
`club-dashboard-astro/`.
