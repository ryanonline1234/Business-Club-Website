# State

Where the project is **right now** and what to do next. Overwrite this file in
place; do not append history to it — history lives in git and
[REBUILD-PLAN.md](REBUILD-PLAN.md).

_Last refreshed: 2026-09-25._

---

## Live

| | |
|---|---|
| Production | <https://mittybusinessclub.vercel.app> |
| Vercel project | `mitty-business-club` (team `ryanonline1234s-projects`) |
| Repo | `ryanonline1234/Business-Club-Website` (renamed 2026-08-13 from `Business-Club-Finance-Helper`) |
| Branch | `rebuild/mbc-portal` — **identical to `main`**; deploys go out from either |
| Schema | `supabase-schema.sql` STEPs 0–19 all applied and verified |

The app is in real use: **98 profiles** (93 members, 5 admins), 2 events
(both cancelled), 0 check-ins, 0 announcements, 0 photos. 55 of those
profiles were pre-registered on 2026-09-25 from the "Business Club Attendance
26/27" sheet (both tabs; 20 more people on it had already signed in) — by a
one-off service-role script that mirrors `POST /api/members/invite` exactly
(auth users tagged `invite_source: 'Business Club Attendance 26/27'`). One
entry was held back: `ishabose@mittymonarch.com` has no grad year, and every
real student address in the database has one. It is fully built and **empty of content** — that gap
is the main thing standing between the site and being worth showing people.

**Add-by-email (the UI) had never been used** as of 2026-09-25. The owner
asked for it again, not knowing it existed. Two likely reasons: its toggle
was a bare uppercase label (no arrow, no button look) that reads as a heading,
and the function logs show *an* officer entering "view as student" just
before visiting `/members` — the logs don't name which officer, so that part
is unconfirmed. 2026-09-25: it is now linked from the home
dashboard (`/members?add=1#add-members` opens it) and its toggle looks like a
button. If an officer says an officer feature is missing, check for the gold
"Viewing as a student" banner first — in the function logs,
`POST /api/preview 200` = *some* officer entered the preview, `303` = left it.

## What exists

Portal (signed-in, "Warm & Mobile-First" design): home, `/calendar` with QR
present mode, `/attendance`, `/members` with roster + approval queue + add-by-email,
`/announcements`. Public: `/about` (the Bold-poster showpiece), `/login`,
`/checkin`, `/join` (the permanent recruiting QR).

Access: Google OAuth, school domains only (`@mittymonarch.com`,
`@mitty.com`), **auto-approved at signup**; officers moderate after the fact.
Treasurer and admin are one capability tier (2026-09-15) — the role values are
titles now, not permission levels.

## Next actions

Nothing is half-finished; these are choices, roughly in the order that pays off.

1. **Put real content on `/about`.** The design is built and empty. One past
   event with a recap, one photo, and officer bios turns the placeholder into
   the record. See [ABOUT-CONTENT-GUIDE.md](ABOUT-CONTENT-GUIDE.md) for what
   good recaps/captions/bios look like.
2. **A second Supabase project for local dev.** Today `npm run dev` reads and
   writes the live club database. This is the sharpest remaining edge now that
   real members are using the site.
3. **Smoke-test CI.** Both production failures found so far (Astro's
   `checkOrigin` 403s, the malformed-cookie 500) were one-curl discoveries. A
   GitHub Action probing ~8 URLs against a preview deploy would have caught
   both.
4. **Canvas announcements — blocked on access, not code.** Posting to a Canvas
   course is one API call; the gate is whether the club has a course shell and
   whether a student token can create announcements there. Three questions to
   answer before building: the course URL, who may post announcements in it,
   and whether that person can generate an access token. Fallback needing
   nobody's permission: an `.ics` feed off the events table.
5. **Optional, designed but unbuilt:** spoken-code check-in fallback, live
   "who's arriving" panel in present mode, capacity enforcement, `audit_logs`
   writes, `AUTH_SECRET` rotation.

## Where to read next

[ARCHITECTURE.md](ARCHITECTURE.md) (guards, env, request flow) ·
[API.md](API.md) (every endpoint + guard) ·
[DATA-MODEL.md](DATA-MODEL.md) (schema, migration) ·
[DEPLOYMENT.md](DEPLOYMENT.md) (env vars, deploy order) ·
[KNOWN-GAPS.md](KNOWN-GAPS.md) (accepted trades — read before "fixing"
anything that looks broken) · [../AGENTS.md](../AGENTS.md) (invariants).
