# API Reference

All endpoints live in `club-dashboard-astro/src/pages/api/` and are rendered
on-demand by the Astro Vercel adapter. Every one of them queries Postgres through
`supabaseAdmin` (service role), so **the auth column below is the only thing
enforcing access** — RLS does not apply. See
[ARCHITECTURE.md](ARCHITECTURE.md#rls-is-defined-but-not-enforced).

## Conventions

- Request and response bodies are JSON unless noted.
- Success shapes vary by endpoint and are **not** consistent — some return
  `{ data }`, some return a bare array, some return `{ success: true }`. Each is
  documented below.
- Errors are `{ "error": "<message>" }` with an appropriate status.
- Sessions come from the Supabase auth cookie; there is no bearer-token path.

| Status | Meaning |
|---|---|
| `400` | Malformed JSON or a missing/invalid required field |
| `401` | No valid session |
| `403` | Session is valid but the role is insufficient |
| `404` | Referenced record not found |
| `409` | Conflict (duplicate check-in) |
| `500` | Supabase returned an error; the message is passed through verbatim |

**Auth levels used below:** `public` (no session), `member` (any signed-in user),
`officer` (`admin` or `treasurer`), `admin`.

---

## At a glance

| Method | Path | Auth | Used by the UI? |
|---|---|---|---|
| `GET` | `/api/auth/signin` | public | ✅ `/login` |
| `GET` | `/api/auth/callback` | public | ✅ OAuth redirect |
| `GET` | `/api/auth/signout` | public | ✅ Sidebar |
| `GET` | `/api/events` | **public** | ❌ |
| `POST` | `/api/events/create` | officer | ✅ `/calendar` |
| `DELETE` | `/api/events/:id/delete` | officer | ❌ |
| `GET` | `/api/events/:id/qr` | **public** | ✅ `/calendar` |
| `GET` | `/api/attendance` | member | ❌ |
| `POST` | `/api/attendance/checkin` | **public** | ✅ `/checkin` |
| `GET` | `/api/members` | member | ❌ |
| `PATCH` | `/api/members/:id` | admin | ✅ `/members` |
| `GET` | `/api/announcements` | **public** | ❌ |
| `POST` | `/api/announcements/create` | officer | ✅ `/announcements` |
| `DELETE` | `/api/announcements/:id` | officer | ✅ `/announcements` |
| `GET` | `/api/finance` | member | ❌ |
| `POST` | `/api/finance/transactions` | member | ✅ `/finance` |
| `PATCH` | `/api/finance/transactions/:id` | officer | ✅ `/finance` |
| `DELETE` | `/api/finance/transactions/:id` | officer | ✅ `/finance` |
| `POST` | `/api/finance/budgets` | officer | ✅ `/finance` |

The ❌ rows are unused by pages in this repo — pages query Supabase directly in
their frontmatter. The three bolded `public` reads are almost certainly
unintentional; see [KNOWN-GAPS.md](KNOWN-GAPS.md#unauthenticated-read-endpoints).

---

## Auth

### `GET /api/auth/signin`

Starts the Google OAuth PKCE flow. Sets the code-verifier cookie and `302`s to
Google. Requests `access_type=offline` and `prompt=consent`.

**Responses:** `302` → Google, or `302` → `/login?error=auth-error`.

### `GET /api/auth/callback`

OAuth redirect target. Exchanges `?code=` for a session, creates the user's
`profiles` row if the signup trigger didn't, then redirects into the app.

| Query | Required | Notes |
|---|---|---|
| `code` | yes | PKCE authorization code from Google |

**Responses**
- `302` → `/calendar` with session cookies set.
- `302` → `/login?error=auth-error&detail=<message>` on exchange failure. The
  underlying Supabase error is also logged to the Vercel function log with the
  cookie header redacted.

Name resolution order: `user_metadata.full_name` → `user_metadata.name` → the
local part of the email. New profiles always get `role: 'member'`.

### `GET /api/auth/signout`

Clears the Supabase session. **Responses:** `302` → `/login`.

---

## Events

### `GET /api/events` — public

Returns all events, newest `start_time` first. No pagination.

```json
[{ "id": "…", "title": "…", "description": "…", "start_time": "…",
   "end_time": "…", "location": "…", "category": "…",
   "status": "active", "created_by": "…" }]
```

`password` is **not** selected, so it never leaves the server here.

### `POST /api/events/create` — officer

| Field | Type | Required |
|---|---|---|
| `title` | string | ✅ |
| `start_time` | ISO timestamp | ✅ |
| `end_time` | ISO timestamp | |
| `description` | string | |
| `location` | string | |
| `category` | string | defaults to `'meeting'` |
| `password` | string | stored but unused — see [KNOWN-GAPS](KNOWN-GAPS.md#eventspassword-is-collected-and-stored-but-never-checked) |
| `capacity` | string/number | parsed with `parseInt`; **not enforced anywhere** |

`status` is forced to `'active'` and `created_by` to the caller's id.

**Responses:** `201 { data }` (the inserted row) · `400` · `401` · `403` · `500`.

### `DELETE /api/events/:id/delete` — officer

**Soft delete.** Sets `status = 'cancelled'`; the row and its attendance records
are retained.

**Responses:** `200 { "success": true }` · `401` · `403` · `500`.

Note the trailing `/delete` segment — this is *not* `DELETE /api/events/:id`.

### `GET /api/events/:id/qr` — public

Mints a fresh signed check-in token for the event and renders it as a QR code.

```json
{ "qr": "data:image/png;base64,…", "event": { "id": "…", "title": "…" } }
```

The token is an HS256 JWT carrying `{ event_id }`, signed with `AUTH_SECRET`,
valid for **4 hours**. Each call issues a new one; old tokens stay valid until
they expire.

**Responses:** `200` · `400` (missing id) · `404` (no such event).

---

## Attendance

### `GET /api/attendance` — member

Every check-in record, newest first, with the member and event joined in. Not
scoped to the caller — any signed-in member sees the full log.

```json
[{ "id": "…", "checked_in_at": "…", "method": "qr",
   "profiles": { "name": "…", "email": "…", "role": "…" },
   "events":   { "title": "…", "start_time": "…" } }]
```

### `POST /api/attendance/checkin` — public

The QR check-in endpoint, called from `/checkin`.

| Field | Type | Required |
|---|---|---|
| `qr_token` | string | ✅ |
| `member_id` | uuid | optional — falls back to the session user |

Flow: verify the JWT signature and expiry → resolve the member (explicit
`member_id` wins, otherwise the session) → reject duplicates → insert with
`method: 'qr'`.

```json
{ "success": true, "member_name": "…", "checked_in_at": "…" }
```

**Responses:** `200` · `400` (bad JSON, missing/expired token, unresolvable
member) · `409 Already checked in` · `500`.

> ⚠️ `member_id` is accepted from the request body without any authorization
> check. See [KNOWN-GAPS.md](KNOWN-GAPS.md#qr-check-in-can-be-done-on-anyones-behalf).

---

## Members

### `GET /api/members` — member

Full roster ordered by role (ascending alphabetical: `admin`, `member`,
`treasurer`).

```json
[{ "id": "…", "name": "…", "email": "…", "role": "member", "created_at": "…" }]
```

### `PATCH /api/members/:id` — **admin only**

The one endpoint where `treasurer` is insufficient.

```json
{ "role": "admin" | "treasurer" | "member" }
```

**Responses:** `200 { data }` · `400` (invalid role) · `401` ·
`403 Only admins can change roles` · `500`.

No guard prevents an admin from demoting themselves, or from demoting the last
remaining admin.

---

## Announcements

### `GET /api/announcements` — public

The 10 most recent announcements, newest first.

```json
[{ "id": "…", "title": "…", "body": "…", "created_at": "…", "author_name": "…" }]
```

### `POST /api/announcements/create` — officer

| Field | Type | Required |
|---|---|---|
| `title` | string | ✅ non-empty after trim |
| `body` | string | ✅ non-empty after trim |

`author_id` and `author_name` are taken from the session.

**Responses:** `201 { data }` · `400` · `401` · `403` · `500`.

### `DELETE /api/announcements/:id` — officer

Hard delete. **Responses:** `200 { "success": true }` · `401` · `403` · `500`.

---

## Finance

### `GET /api/finance` — member

One aggregate call returning everything the finance page needs.

```json
{
  "categories":   [{ "id": "…", "name": "…", "slug": "…", "icon": "…" }],
  "budgets":      [{ "id": "…", "name": "…", "amount": "…", "spent": "…",
                     "category_id": "…", "starts_at": "…", "ends_at": "…",
                     "created_at": "…" }],
  "transactions": [{ "id": "…", "amount": "…", "description": "…",
                     "merchant": "…", "status": "…", "created_at": "…",
                     "category_id": "…", "user_id": "…",
                     "categories": { "name": "…" },
                     "profiles":   { "name": "…", "email": "…" } }]
}
```

**Scoping:** officers get all transactions; members get only their own
(`user_id = session.id`). Capped at 100 transactions, newest first. Categories
are filtered to `is_active = true`. Budgets are **not** scoped or filtered by
date — every budget ever created is returned to everyone.

### `POST /api/finance/transactions` — member

Any signed-in member can submit an expense. It lands as `pending`.

| Field | Type | Required |
|---|---|---|
| `amount` | number/string | ✅ must parse to a positive number |
| `description` | string | ✅ |
| `category_id` | uuid | ✅ |
| `merchant` | string | |

`user_id` is taken from the session — a member cannot file on someone else's
behalf. `status` is forced to `'pending'`.

**Responses:** `201 { data }` · `400` · `401` · `500`.

### `PATCH /api/finance/transactions/:id` — officer

Approve or reject.

```json
{ "status": "approved" | "rejected" | "pending" }
```

**Responses:** `200 { data }` · `400` · `401` · `403` · `500`.

> Approving a transaction does **not** update `budgets.spent`. See
> [KNOWN-GAPS.md](KNOWN-GAPS.md#budgetsspent-is-never-updated).

### `DELETE /api/finance/transactions/:id` — officer

Hard delete, no soft-delete or audit trail.

**Responses:** `200 { "success": true }` · `401` · `403` · `500`.

### `POST /api/finance/budgets` — officer

| Field | Type | Required |
|---|---|---|
| `name` | string | ✅ |
| `amount` | number/string | ✅ parsed with `parseFloat` |
| `category_id` | uuid | ✅ |
| `starts_at` | ISO timestamp | ✅ |
| `ends_at` | ISO timestamp | ✅ |

`spent` is initialised to `0` and never changes after that.

**Responses:** `201 { data }` · `400` · `401` · `403` · `500`.

There is no `PATCH` or `DELETE` for budgets — editing one means going to the
Supabase table editor.
