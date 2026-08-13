# /about Content Guide

How the public page ([`about.astro`](../club-dashboard-astro/src/pages/about.astro))
turns database rows into "the record," and what good content looks like. The
design came from an external agent pass (commit `84d8565`); the target look was
shared as a placeholder-filled preview (hyperagent.com share, 2026-08-13 —
link-rotted by now, essentials captured here).

**The premise, from the mock's own manifesto:** *"Every event on this page
actually happened — dated, filed, and written up by the officers who ran it.
If it's not on the record, we didn't do it. That's the whole pitch."* Content
should live up to that: real events, real numbers, real photos.

---

## Section → data source

| Section on the page | Fed by | Officer action |
|---|---|---|
| Masthead, live PT clock, season, tape, seal | Computed | Nothing |
| SEC. 00 · The Pitch (manifesto) | Hardcoded copy + **newest photo with no `event_id`** as the duotone plate | Upload one great atmospheric shot *unattached* |
| Giant numeral + stats strip | Counts of events / photos / officers | Nothing — derived |
| Broadsheet write-ups (drop cap, big date slab, № numbering) | Past events **with `recap` text**, newest first | Write the recap in `/calendar` → past event → Recap & photos |
| Photo stamps inside a write-up | `photos` rows with that `event_id` | Upload + attach, give each a short `caption` |
| "More from the season" compact rows | Past events **without** a recap | Automatic |
| "Around the club" drag-rail | The *other* unattached photos | More unattached uploads |
| SEC. 02 · Officers | `profiles` where role admin/treasurer, status approved | Each officer writes `bio` on `/members` |
| SEC. 03 · Footer + colophon | Hardcoded | Nothing |

Everything fails soft: pre-migration databases render events/officers minus the
missing columns, never a 500.

---

## What the placeholder mock teaches about content

The mock rendered the page "full" — 14 events, 3 write-ups, 7 photos, 3
officers — and its fake content is a deliberate style guide:

**Recaps** (2 short paragraphs each, never more):
- Open strong — the first letter becomes the drop cap. "Six teams, five
  minutes each, one whiteboard that barely survived."
- Concrete numbers over adjectives: "$40 float," "hot chocolate at $2 outsold
  candy three to one once the sun went down," "the answer filled two
  whiteboards."
- Second paragraph lands an outcome or a callback: "We cleared enough to fund
  the spring speaker series."
- A blank line = paragraph break (each line break starts a new `<p>`).

**Captions** — they render as black/gold stamps on the photos, so write them
like stamps: short, dry, specific. The mock's best: *"THE LEDGER. EVERY
DOLLAR, BOTH DIRECTIONS."* / *"PREP TABLE, TWENTY MINUTES BEFORE DOORS."*

**Officer bios** — the mock's format, worth copying: class year first, then one
personality-forward sentence about what they actually do. *"Sophomore. Counts
every dollar twice. The ledger in the photos above is his handwriting."*
1–3 sentences; longer gets truncated by design pressure, not code.

**Categories** — one word (`Meeting`, `Speaker`, `Fundraiser`, `Showcase`,
`Workshop`); they render in the bordered chips on write-ups and rows.

**Photos** — everything renders in gold duotone (full color on hover), so
ordinary phone photos land on-palette automatically. Shoot candid and
horizontal; everything crops to 4:3. Upload cap 4 MB (Vercel body limit).
**Never publish AI-generated photos** — the mock's images were props; the
page's entire premise is that the record is real.

**Volume targets** (when the page feels "full" per the mock): ~3 recapped
write-ups on top, any number of compact rows below, ~5–7 photos total with at
least one unattached for the manifesto plate, every officer with a bio.

---

## The six hardcoded brand strings

All in [`about.astro`](../club-dashboard-astro/src/pages/about.astro) — search
for them. Editing these is copywriting, not coding:

1. **Standfirst** — "The student-run business club at Archbishop Mitty…"
2. **Manifesto** — "No hype. / No highlight reel. / Just the record." + the
   italic note under it
3. **Footer headline** — "Come see for yourself."
4. **Seal text** (rotating badge) — "MITTY BUSINESS CLUB ✱ SAN JOSE ✱ THE
   RECORD ✱" — keep ≤ ~46 characters so the circle closes
5. **Tape text** — the `tapeUnit` constant in the frontmatter
6. **Colophon** — "Three inks · two typefaces · zero libraries…"

---

## Engineering constraints (do not trade for content features)

- The frontmatter select lists are a **privacy boundary** — see
  [KNOWN-GAPS.md](KNOWN-GAPS.md). Adding a column to a select on this page is
  a privacy decision, not a refactor.
- Self-contained: no CDNs, no external fonts/images/scripts. Photos come only
  from the `club-photos` Supabase bucket.
- Recaps/bios/captions are plain text, server-rendered and escaped. No HTML in
  content, ever.
