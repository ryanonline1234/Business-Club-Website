# Mitty Business Club — Officer Portal

Member portal for the Mitty Business Club: home dashboard, event calendar with
projected QR check-in, attendance history, member roster with an officer
approval queue, and announcements.

Built with **Astro 5** (SSR, no client framework) + **Supabase** (Postgres,
Google OAuth, RLS), deployed on **Vercel**. One app, at
`club-dashboard-astro/` — the legacy Next.js app that used to sit at the repo
root was deleted in the rebuild.

---

## ⚠️ Read this first: the migration ships before the code

The app selects `profiles.status` on every request. Deploying the code before
[`supabase-schema.sql`](supabase-schema.sql) has been applied means that select
errors, `getSession` fails closed by design, and **every user lands on
`/pending` with no way out**. The other order is safe.

The full sequence — including the STEP 0 pre-flight you must read before
anything else — is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#deploy-order-sql-first-then-code).
Do not deploy from memory.

---

## Access model

Two gates, both enforced server-side:

1. **School Google accounts only** — `@mittymonarch.com` (students) or
   `@mitty.com` (faculty). Anything else is rejected in the OAuth callback and
   the auth account is deleted so a retry with the right account is clean.
   One exception: an *already-approved* profile on another domain keeps its
   access (the grandfather clause — the club's admin uses a personal address).
2. **Officer approval** — every new account lands on `/pending` until an
   officer (admin *or* treasurer) approves it from `/members`.

Three roles: `member`, `treasurer`, `admin`. "Officer" means an **approved**
admin or treasurer. Role changes are admin-only; approvals are officer-wide.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roles-and-authorization).

---

## Quickstart

```bash
cd club-dashboard-astro
npm install
```

Create `club-dashboard-astro/.env`:

```env
PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
AUTH_SECRET=<openssl rand -base64 48>
SITE_URL=http://localhost:3000
```

All five are **required** — the app validates them at boot
(`src/lib/env.ts`) and refuses to start with any missing, rather than run
with forgeable QR tokens or a broken OAuth flow.

```bash
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/login`.

> **Local dev talks to the real Supabase project.** There is no local database
> and no seed script; anything you create locally is production data. Use a
> second Supabase project if that matters.

Full setup (Supabase project, Google OAuth, Vercel) is in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Request flow, the guard layer, env validation, the two Supabase clients, QR check-in, the design system |
| [docs/API.md](docs/API.md) | Every endpoint: method, guard, request body, responses, CSRF behavior |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Tables, the approval migration, RLS policies, the signup trigger |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Env vars, deploy order, the SITE_URL cutover, and the auth bugs that have already bitten this project |
| [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md) | What the rebuild fixed, what's still open, accepted trades |
| [docs/REBUILD-PLAN.md](docs/REBUILD-PLAN.md) | The rebuild spec this code implements, with status |

---

## Pages

| Route | Guard | Notes |
|---|---|---|
| `/` | approved | Home: greeting, next event, latest announcements, club figures; officers also see the approval-queue nudge |
| `/about` | **public** | The club's showcase for non-members: past events with officer-written recaps and photos, officer bios, link to the school's clubs page. Its own Bold Graphic design, not the portal's Warm system; renders empty-but-alive until STEPs 16–18 of the schema are applied |
| `/login` | public | Google sign-in; fixed error copy keyed by `?error=` |
| `/pending` | any session | Waiting room: pending / declined / server-error states |
| `/calendar` | approved | Month grid + agenda; officers get event composer, cancel, and Present mode (projected QR, auto-refreshing) |
| `/attendance` | approved | Officers see the club log and turnout; members see **only their own** history |
| `/members` | approved | Roster; emails officer-only; approval queue officer-only; role select admin-only |
| `/announcements` | approved | Server-rendered feed; officers compose and delete |
| `/checkin?token=…` | public | QR landing page; sign-in round-trips back to the scan via `?next=` |

"approved" means `requireApproved` — signed in AND officer-approved. Officer
and admin *controls* are rendered server-side only for those roles, never
CSS-hidden.

## Scripts

Run from `club-dashboard-astro/`:

```bash
npm run dev      # astro dev — localhost:3000
npm run build    # astro build — emits .vercel/output
npm run preview  # serve the production build locally
```

There is no test suite and no lint script; `npm run build` is the only
pre-merge check. There is no root `package.json`.

## License

MIT — see [LICENSE](LICENSE).
