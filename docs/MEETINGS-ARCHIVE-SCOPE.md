# Meetings archive — scope

_Scoped 2026-10-01. Not built. Owner decision so far: **slides links are
members-only** (not on the public `/about`)._

The ask: a place where meetings are registered and listed, where you can go
back to a past meeting, open its slides, and where officers can edit its
description and upload photos.

## Conclusion

Most of the pieces already exist, spread across `/calendar`, `/attendance`
and `/about`. What's missing is (1) a **list of past meetings** — the calendar
only pages month by month — (2) a **slides link** (no column for it), and (3)
a **photo upload that works from an iPad**. Since 2026-10-01 the event edit
endpoint (`PATCH /api/events/:id`), shared field validation
(`lib/event-input.ts`) and the shared time rules (`lib/event-time.ts`) exist,
which takes roughly half a day off the original estimate.

**Recommended build:** `/meetings` (the list) and `/meetings/[id]` (one page per
meeting — the canonical home of its record), one new column
`events.slides_url` (STEP 20), and client-side photo downscaling for iPads.

**Effort:** ~1–1.5 focused days for the minimum version, plus ~0.5–1 day for
the iPad photo work. Deploy order: STEP 20, then the code.

---

## 1. What exists and is reused

| Piece | Where | Gives the archive |
|---|---|---|
| `events.description` | create + **edit** (`PATCH /api/events/:id`) | "What this meeting is" — members only (`/about` never selects it). Renders without line breaks today (`.event-detail__desc` lacks `pre-line`) |
| `events.recap` (STEP 17) | `PATCH /api/events/:id/recap` | "What happened" — **public** on `/about`. Past events only |
| `photos` + `club-photos` bucket (STEP 18) | `POST /api/photos`, `DELETE /api/photos/:id` | Per-event photos, public by design |
| Calendar "Recap & photos" block | `calendar.astro` | The officer recap editor and photo upload/delete — **moves** to the meeting page |
| Attendance PDF | `GET /api/events/:id/attendance.pdf` | Linked from the meeting page too |
| `/attendance` Meeting sheets | `attendance.astro` | Already an officer list of meetings with counts; rows would link to the meeting page |
| Member ✓ | calendar / home | "You were there" per meeting |

## 2. Routes and who sees what

**`/meetings` — the list** (`requireApproved`).
- Upcoming: the next few, plus "Full calendar →".
- Past: newest first, grouped by school year (Aug–Jul, Pacific day keys).
  Each row: date, title, category · location, and chips — **Slides**,
  **N photos**, **Recap**.
- Members also see **✓ You were there** (one query for their own rows).
- Officers also see the check-in count and gold "No recap" / "No photos"
  chips, with a header line "N past meetings have no recap" — this directly
  drives STATE.md's next action #1 (real content on `/about`).
- Officers: **Add a past meeting** → `/calendar?new=1#event-form` (the New
  event form already accepts past start times).
- Cancelled events hidden, as on the calendar.

**`/meetings/[id]` — one meeting** (`requireApproved`; non-UUID / unknown /
cancelled → not found).
- Everyone: title, category, when/where, description (with line breaks),
  **Open slides** as the main button with its source ("Google Slides ·
  docs.google.com"), the recap, the photo grid, your own check-in, the count.
- Officers, each block marked "Officer only": **Edit details** (every field
  incl. slides — the existing PATCH), **Recap** and **Photos** (moved from the
  calendar), **Attendance PDF**.
- Layout reuses `.home` (main column + side rail from 940px).

**Navigation — no sixth top-nav item.** At iPad-landscape widths the officer
top bar was already over budget (fixed 2026-10-01 by giving the nav its own
row up to 1179px). Reach `/meetings` from visible buttons on the calendar,
the event detail, and `/attendance` rows; treat `/meetings*` as part of the
Calendar tab in `TopRail`/`ThumbBar`. Links must look like buttons — the
add-by-email panel went unused because nobody could find it.

## 3. One place per edit control

Rule: anything that **changes** data lives in exactly one place; read-only
links and downloads may repeat.

| Action | Canonical place once the archive ships | Calendar event detail |
|---|---|---|
| Present check-in code | Calendar (live, time-critical) | unchanged |
| Cancel event | Calendar | unchanged |
| Edit details (all fields + slides) | `/meetings/[id]` | **Today it lives on the calendar** (built 2026-10-01). When the archive ships it **moves**, and the calendar shows a "Meeting page →" link instead — never two edit forms for one event |
| Recap, photos | `/meetings/[id]` | Block replaced by "Recap, slides & photos →" (~240 lines leave `calendar.astro`) |
| Attendance PDF (download) | meeting page, `/attendance`, calendar | stays |

## 4. Slides link — one column, not a table

`events.slides_url text`. A separate `event_links` table waits until someone
actually needs a second kind of link (recording, worksheet) — the owner's
"defer abstractions until 2–3 real uses" rule; moving later is one
`insert … select`.

**Validation** (`src/lib/slides-link.ts`, server is the authority):
`new URL(raw.trim())`; protocol exactly `https:`; no userinfo, no port;
≤ 2048 chars; store `url.href`. Host allow-list with exact-or-dot-suffix
matching (so `evilgoogle.com` and `docs.google.com.evil.com` fail):
`docs.google.com` (Google Slides for `/presentation/`, else Google Docs),
`drive.google.com` (Google Drive), `canva.com` + subdomains (Canva). The label
is derived from the host server-side, never typed — a link can't claim to be
something it isn't.

**Rendering:** re-validate on render (a stored value that fails renders no
link); `<a href target="_blank" rel="noopener noreferrer">`. **No iframe, no
embed, no favicon fetch** — embedding Google Slides would load third-party
scripts and break invariant 10. Input: `type="url" inputmode="url"
autocapitalize="off" autocorrect="off" spellcheck="false"` (iPad URL keyboard).

**Members only** (owner decision): `/about`'s select lists are the public
boundary; decks shared "anyone at Mitty with the link" would send public
visitors to a Google login wall; decks can hold member names and plans.

## 5. Schema — STEP 20

```sql
-- ── STEP 20: one slides link per event — MEMBERS ONLY ──────────────────────
-- Read by /meetings and /meetings/[id] (requireApproved). NOT selected by
-- /about — its select list is the public boundary (KNOWN-GAPS). RLS needs no
-- change: STEP 14's approved-members read on events already covers it.
-- The host allow-list lives in src/lib/slides-link.ts; this constraint is
-- only the second line: https, bounded. Safe any time, repeatedly.
alter table public.events
  add column if not exists slides_url text;
alter table public.events
  drop constraint if exists events_slides_url_check;
alter table public.events
  add constraint events_slides_url_check
  check (slides_url is null
         or (slides_url like 'https://%' and length(slides_url) <= 2048));
```

Code fails soft before it's applied (reads retry without the column; PATCH
answers "run STEP 20" on `42703`/`PGRST204`). Same-change doc updates: the SQL
file header ("STEPs 16–20"), DATA-MODEL, KNOWN-GAPS.

## 6. Endpoints

- **`PATCH /api/events/:id`** — exists. Add `slides_url` to
  `lib/event-input.ts` (validated by `parseSlidesUrl`; `''` clears it).
  Description and slides are editable any time (slides often go up before
  the meeting); recaps stay past-only.
- Optional, S: **`PATCH /api/photos/:id { caption }`** — with multi-photo
  upload, captioning afterwards beats typing one per file.

## 7. Photos from an iPad — the part that's broken today

Today the calendar's uploader rejects anything over 4MB in the browser with
"Resize it and try again" — which many full-size iPad camera photos exceed,
and an iPad has no easy way to resize. (Vercel's ~4.5MB request limit is the
real ceiling behind that check.)

- `accept="image/*" multiple`, **no** `capture` attribute (iPadOS then offers
  Take Photo / Photo Library / Choose File).
- Shrink in the browser before upload: decode → canvas, longest side ≤
  2048px (`/about` shows photos at ~800×600) → `toBlob('image/jpeg', 0.85)`.
  Expected well under 1MB for a 12MP photo (estimate — check on a device).
- Side benefit: re-encoding **strips EXIF, including GPS location**; today the
  server publishes whatever bytes it receives to a public bucket.
- HEIC from the Files app arrives unconverted (the server rejects it); Safari
  decodes HEIC, so the re-encode converts it to JPEG.
- One `POST /api/photos` per file, sequential, with "Uploading 2 of 5…"; reload
  once at the end. Server unchanged — the 8MB cap and magic-byte check stay
  the real controls.
- Open delete-confirm on narrow photo tiles wraps into three rows; fix with
  `.photogrid li:has(> .confirm[open]){ grid-column:1 / -1 }`.

**Verify on a real iPad:** orientation after canvas re-encode, HEIC from Files
vs Photo Library, whether iOS already strips GPS, Canva short-link shapes.

## 8. Effort

S ≈ up to 2h, M ≈ half a day.

| # | Piece | Size |
|---|---|---|
| 1 | STEP 20 + schema header + DATA-MODEL | S |
| 2 | `lib/slides-link.ts` (validate + label) + `slides_url` in `lib/event-input.ts` | S |
| 3 | `/meetings` list (grouping, chips, member ✓, officer missing-content chips) | M |
| 4 | `/meetings/[id]` read view | M |
| 5 | Officer blocks on the meeting page: Edit details + Recap + Photos **moved** from the calendar | S–M |
| 6 | Wiring: calendar "Meeting page →", `?new=1`, `/attendance` row links, nav highlight | S |
| 7 | iPad photo upload (downscale, multiple, progress, confirm fix) + real-iPad test | M |
| 8 | Caption edit (optional) | S |
| 9 | Docs: STATE, API, KNOWN-GAPS, ABOUT-CONTENT-GUIDE ("write the recap in /calendar" changes) | S |

**Minimum (1–6, 9): ~1–1.5 days. Plus 7–8: ~0.5–1 day.** Piece 7 can ship
first on its own — it fixes the existing calendar uploader today.

## 9. Open decisions

1. **Where are events edited once this ships?** Recommended: `/meetings/[id]`
   for every field; the calendar keeps Present and Cancel and links over.
   (Cheaper alternative: the list links to `/calendar?event=…` and editing
   stays on the calendar.)
2. **Description vs recap** — keep both, clearly labelled (members-only "what
   this meeting is" vs public "what happened")? Recommended: keep both.
3. **One slides link, or several links** (recording, worksheet, form)?
   Recommended: one now.
4. ~~Slides visibility~~ — decided: members only.
5. **Allowed link hosts** — Google Docs/Drive and Canva; add Microsoft
   (OneDrive/SharePoint), Pitch, Prezi?
6. **Navigation** — no sixth nav item (recommended), or rename "Calendar" to
   "Meetings" and make it the hub?
7. **What counts as a meeting** — exclude `deadline` events from the archive?
8. **Photos public** (recommended) or members-only photos (private bucket +
   signed URLs — large)?
9. **Photo size** — is downscaling to 2048px fine, or do you need originals?
10. **"Registered"** — read here as recorded and listed. If you meant members
    signing up for meetings in advance (RSVP), that's a separate scope.
