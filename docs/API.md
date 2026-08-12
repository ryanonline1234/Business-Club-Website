# API Reference

All endpoints live in `club-dashboard-astro/src/pages/api/`. Every one queries
Postgres through `supabaseAdmin` (service role), so **the guard on each
endpoint is the only thing enforcing access** — RLS does not apply on this
path. Guards come from `src/lib/auth.ts`; no endpoint hand-rolls its own
check. See [ARCHITECTURE.md](ARCHITECTURE.md#the-guard-layer).

The read surface is deliberately tiny: pages read Postgres directly in their
frontmatter, so there are **no JSON list endpoints**. The old app's
`GET /api/events`, `/api/announcements`, `/api/attendance`, `/api/members`
(two of them unauthenticated) and the entire `/api/finance/**` module were
deleted in the rebuild. If you need a new read, put it in page frontmatter.

## Conventions

- Request and response bodies are JSON unless noted.
- Errors are `{ "error": "<human-readable message>" }`. Some carry a machine
  `reason` field, noted per endpoint. **Raw Postgres/Supabase messages are
  never echoed to the client** — detail goes to the Vercel function log.
- Sessions come from the Supabase auth cookie; there is no bearer-token path.
- Every response is built with `apiJson(...)`, which preserves refreshed
  session `Set-Cookie` headers even on rejections.

### Guard responses (identical on every guarded endpoint)

| Status | Body | When |
|---|---|---|
| `403` | `{ "error": "Invalid origin" }` | Mutating method from a cross-site origin (CSRF check — `Origin` / `Sec-Fetch-Site` vs `SITE_URL` or the request's own origin) |
| `401` | `{ "error": "Unauthorized" }` | No valid session |
| `403` | `{ "error": "Account pending approval", "status": "pending" \| "rejected" }` | Signed in but not approved |
| `403` | `{ "error": "Forbidden" }` | Approved but insufficient role (officer/admin endpoints) |

Checks run in that order — the origin check fires before authentication.

**Auth levels used below:** `public` (no session), `approved` (signed in AND
`status='approved'`), `officer` (approved `admin` or `treasurer`), `admin`
(approved `admin`).

---

## At a glance

| Method | Path | Guard | Called from |
|---|---|---|---|
| `GET` | `/api/auth/signin` | public | `/login`, `/checkin` |
| `GET` | `/api/auth/callback` | public | OAuth redirect |
| `GET`/`POST` | `/api/auth/signout` | public + cross-site check | layout & `/pending` sign-out forms |
| `POST` | `/api/events/create` | officer | `/calendar` composer |
| `DELETE` | `/api/events/:id/delete` | officer | `/calendar` cancel |
| `GET` | `/api/events/:id/qr` | **officer** | `/calendar` Present mode |
| `POST` | `/api/attendance/checkin` | **approved** | `/checkin` |
| `PATCH` | `/api/members/:id` | **admin** | `/members` role select |
| `PATCH` | `/api/members/:id/status` | officer | `/members` approval queue |
| `POST` | `/api/announcements/create` | officer | `/announcements` composer |
| `DELETE` | `/api/announcements/:id` | officer | `/announcements` delete |

---

## Auth

### `GET /api/auth/signin` — public

Starts the Google OAuth PKCE flow: sets the code-verifier cookie and `302`s to
Google. Sends `access_type=offline`, `prompt=consent`, and `hd: '*'` (a
chooser hint only — never trusted; the callback enforces the domain).

| Query | Required | Notes |
|---|---|---|
| `next` | no | Same-origin path to return to after sign-in. Validated by `safeNextPath()` (root-relative, non-auth paths only; rejected values silently dropped) and stashed in the 10-minute httpOnly `mbc-next` cookie for the callback. |

**Responses:** `302` → Google, or `302` → `/login?error=auth-error`.

### `GET /api/auth/callback` — public

OAuth redirect target: exchanges `?code=` for a session, enforces the school
domain, creates/refreshes the profile row, routes on approval status.

| Query | Required | Notes |
|---|---|---|
| `code` | yes | PKCE authorization code (absent when the user cancels at Google) |

Order of operations (load-bearing — see the file header before editing):

1. Exchange the code for a session.
2. **Read** the existing profile (nothing is written before the domain call).
3. Domain gate: non-school addresses are rejected — `signOut()` first, then
   `admin.deleteUser()` so a retry is clean — **unless** the existing profile
   is already `approved` (the grandfather clause).
4. Profile fallback: missing row → insert `{id, email, name}` only; existing
   row → update `email`/`name` only. **Never `role`, never `status`.**
5. Route: `approved` → the validated `next` path or `/`; anything else →
   `/pending`.

**Responses** (all `302`, all with session cookies on the redirect):
- → `SITE_URL` + (`next` path or `/`) on success for an approved account
- → `/pending` for pending/rejected accounts, or when the profile could not
  be read after an allowed-domain sign-in (fail-closed, no blind write)
- → `/login?error=domain` — non-school address, account deleted
- → `/login?error=auth-error` — exchange failure, missing code, or a profile
  lookup failure during the domain check (session dropped, account NOT
  deleted — a transient blip must not destroy the grandfathered admin)

Error codes in URLs are a **fixed set** — `domain` and `auth-error` are the
only values this route emits (`/login` also has copy for `pending`). Provider
error text never reaches a URL; it goes to the function log.

### `GET | POST /api/auth/signout` — public + cross-site check

Clears the Supabase session, `302` → `/login`. Both methods run
`checkSafeNavigation`, which rejects cross-site triggers (e.g. a hostile
`<img src=…/signout>`) with `403 { "error": "Invalid origin" }` via
`Sec-Fetch-Site` — such requests carry no `Origin` header. The UI signs out
with POST forms; GET remains for direct navigation and old links.

---

## Events

### `POST /api/events/create` — officer

| Field | Type | Required | Limits |
|---|---|---|---|
| `title` | string | ✅ | ≤ 200 chars after trim |
| `start_time` | ISO timestamp | ✅ | must parse |
| `end_time` | ISO timestamp | | must parse and be after `start_time` |
| `description` | string | | ≤ 5000 |
| `location` | string | | ≤ 300 |
| `category` | string | | ≤ 60; defaults to `'meeting'` |
| `capacity` | number/string | | absent/`''`/`null` = no cap; otherwise a positive integer (stored, **not enforced** at check-in) |

`status` is forced to `'active'`, `created_by` to the caller. There is **no
`password` field** — a `password` key in the body is silently ignored (the
column is dead; the old app stored it in plaintext for a flow that never
existed).

**Responses:** `201 { data }` (the inserted row) · `400` (validation, message
names the field) · guard responses · `500 { "error": "Could not create the event" }`.

### `DELETE /api/events/:id/delete` — officer

**Soft delete**: flips `status` to `'cancelled'`. The row and its attendance
records survive; a mistaken cancel is reversible from the table editor. Note
the trailing `/delete` segment.

**Responses:** `200 { "success": true }` · `400 { "error": "Invalid event id" }`
(non-UUID path segment — checked before Postgres can 500 on it) · guard
responses · `500`.

### `GET /api/events/:id/qr` — officer

Mints a **bearer check-in token** (hence the officer gate — this endpoint had
no auth at all in the old app) and renders it as a QR PNG. Response is
`Cache-Control: no-store`; a cached QR is a token in a shared cache.

```json
{
  "qr": "data:image/png;base64,…",
  "event": { "id": "…", "title": "…" },
  "expires_at": "2026-08-11T21:00:00.000Z",
  "expires_in": 900
}
```

The token lives **15 minutes** (`QR_TOKEN_TTL_SECONDS` in `lib/qrcode.ts` —
the short window is the security property; do not lengthen it). `/calendar`'s
Present mode re-fetches at `expires_in − 180s` so the projected code never
goes stale on screen.

Minting is refused for events that can no longer accept check-ins:

**Responses:** `200` · `400` (missing id) · `404` (no such event) ·
`409 { reason: "event_not_active" }` (cancelled/completed) ·
`409 { reason: "checkin_closed", closed_at }` (past `end_time + 2h`, or
`start_time + 4h` with no end) · guard responses · `500`.

There is deliberately no *lower* bound here (unlike check-in itself): an
officer setting up a room early may open Present mode before the window opens.

---

## Attendance

### `POST /api/attendance/checkin` — approved

Records **the caller's** attendance. The body carries `qr_token` and nothing
else; the member written is always `session.id`. The old endpoint accepted
`member_id` from the body — that was the impersonation hole, and a `member_id`
key in the body is now logged as a probe and ignored. **Never reintroduce a
client-supplied identity here.**

| Field | Type | Required |
|---|---|---|
| `qr_token` | string | ✅ |

Three independent checks before the insert: (1) caller signed in and approved,
(2) token signature/expiry/issuer/audience valid, (3) the event exists, is
`'active'`, and is inside its check-in window (`start_time − 30 min` →
`end_time + 2 h`, or `start_time + 4 h` when there's no end time).

**Responses:**
- `201 { "success": true, "member_name": "…", "checked_in_at": "…", "event": { "id", "title" } }`
- `400` — bad JSON, missing `qr_token`, or an invalid/expired token (friendly
  message: ask an officer for a fresh code)
- `403 { reason: "event_not_active" }` · `403 { reason: "checkin_not_open", opens_at }`
  · `403 { reason: "checkin_closed", closed_at }`
- `404` — validly-signed token for a deleted event
- `409 { "error": "Already checked in", "checked_in_at": "…" }` — explicit
  duplicate lookup; the unique constraint catches the race and returns the
  same 409 without `checked_in_at`
- guard responses · `500` (fixed message, detail in the log)

---

## Members

### `PATCH /api/members/:id` — **admin only**

Change a member's **role**. The one endpoint where `treasurer` is
insufficient — a treasurer must not be able to mint an admin.

```json
{ "role": "admin" | "treasurer" | "member" }
```

**The last-admin guard:** a write that would take the approved-admin count to
zero is refused `409` — otherwise nobody can approve or promote anyone ever
again, and recovery is hand-editing the database. If the admin *count query
itself* fails, the endpoint fails closed with `503` and writes nothing.
Self-demotion is allowed as long as another approved admin remains (the
"I'm graduating" path). The count-then-write is not atomic — see
[KNOWN-GAPS.md](KNOWN-GAPS.md#the-last-admin-guard-is-not-atomic).

**Responses:** `200 { data }` (also for an idempotent same-role no-op, which
skips the write) · `400` (missing id / invalid role) · `404` · `409`
(last admin, or the STEP 9 domain check constraint if applied) · `503`
(count failed) · guard responses · `500`.

### `PATCH /api/members/:id/status` — officer

Approve or decline an account. Officer-wide **on purpose** — treasurers run
meetings, and letting members in is part of running a meeting.

```json
{ "status": "approved" | "rejected" }
```

`'pending'` is not settable: there is no reason to push a decided account back
into the queue, and allowing it would let an officer erase a decision.
Reversible in both directions (a declined account can be re-approved here).

Four refusals, in order:

1. **Self** — `403`: an officer may not rule on their own account.
2. **Missing** — `404` for an unknown id.
3. **Domain** — `409`: approving a non-school address is refused (declining
   one is allowed — that's how you dispose of a bad row).
4. **Last admin** — `409`: declining the only approved admin is refused; a
   failed count query fails closed with `503`.

On success the row is stamped with `approved_by` / `approved_at` — **who
ruled**, not only who said yes; declines are stamped identically.

**Responses:** `200 { data }` · `400` · `403` (self) · `404` · `409` · `503` ·
guard responses · `500`.

---

## Announcements

### `POST /api/announcements/create` — officer

| Field | Type | Required | Limits |
|---|---|---|---|
| `title` | string | ✅ non-empty after trim | ≤ 200 |
| `body` | string | ✅ non-empty after trim | ≤ 20000 |

`author_id` and `author_name` come from the session, never the client. The
stored body is plain text — pages render it server-side, escaped; never
`innerHTML`.

**Responses:** `201 { data }` · `400` · guard responses · `500`.

### `DELETE /api/announcements/:id` — officer

Hard delete (announcements have no dependent rows).

**Responses:** `200 { "success": true }` · `400 { "error": "Invalid announcement id" }`
(non-UUID) · guard responses · `500`.
