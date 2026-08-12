# Treasury Club Dashboard

Officer portal for the Mitty Business Club: club calendar, QR-code event
check-in, member roster with roles, announcements, and treasury tracking
(budgets, transactions, approvals).

Built with **Astro 5** (SSR) + **Supabase** (Postgres, Auth, RLS), deployed on
**Vercel**.

---

## ⚠️ Read this first: there are two apps in this repo

| Path | Stack | Status |
|---|---|---|
| `club-dashboard-astro/` | Astro 5 + Supabase | **This is the live app.** All current work happens here. |
| `src/` (repo root) | Next.js 16 + NextAuth | **Legacy / not deployed.** Superseded by the Astro app. |

`vercel.json` at the repo root makes this explicit — it skips the root install
entirely and builds only the Astro app:

```json
{
  "buildCommand": "cd club-dashboard-astro && npm install && npm run build && mv .vercel/output ../.vercel/output",
  "installCommand": "echo 'skip root install'",
  "framework": null
}
```

The root `package.json`, `next.config.ts`, `src/`, `public/`, `eslint.config.mjs`,
and `postcss.config.mjs` all belong to the dead Next.js app. Changing them has no
effect on production. See [Known gaps](docs/KNOWN-GAPS.md#the-dead-nextjs-app)
for the cleanup decision that's still outstanding.

`supabase-schema.sql` at the repo root **is** shared and current — it's the
schema both apps were written against, and the Astro app is the one that uses it.

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
AUTH_SECRET=<random 32+ char string>
SITE_URL=http://localhost:3000
```

Then:

```bash
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/login`.

Full setup (Supabase project, Google OAuth, Vercel) is in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a request flows, the auth model, why every query uses the service-role client, directory layout |
| [docs/API.md](docs/API.md) | Every endpoint: method, auth requirement, request body, responses |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Tables, columns, constraints, RLS policies, the signup trigger |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Env vars, Supabase + Google OAuth setup, Vercel config, and the auth bugs that have already bitten this project |
| [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md) | Unimplemented schema features, auth holes, and open decisions |

---

## Pages

| Route | Auth | Notes |
|---|---|---|
| `/` | — | Redirects to `/calendar` if signed in, else `/login` |
| `/login` | public | Google OAuth sign-in |
| `/calendar` | member+ | Event list; officers can create events and display a check-in QR |
| `/attendance` | member+ | Check-in log with per-event and per-member rollups |
| `/members` | member+ | Roster; **admins** can change roles inline |
| `/announcements` | member+ | Feed; officers can post and delete |
| `/finance` | member+ | Budgets and transactions; officers see all, members see only their own |
| `/checkin?token=…` | public | QR landing page members hit from their phones |

"Officer" means role `admin` or `treasurer`. See
[the role model](docs/ARCHITECTURE.md#roles-and-authorization).

## Scripts

Run from `club-dashboard-astro/`:

```bash
npm run dev      # astro dev — localhost:3000
npm run build    # astro build — emits .vercel/output
npm run preview  # serve the production build locally
```

There is no test suite and no lint script in the Astro app. The root
`npm run lint` lints the dead Next.js app only.

## License

MIT — see [LICENSE](LICENSE).
