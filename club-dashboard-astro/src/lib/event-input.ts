/**
 * Validation for event fields, shared by POST /api/events/create and
 * PATCH /api/events/:id so the two can never disagree about what a valid
 * event is. Pure: body in, fields or a client-safe error string out.
 *
 * `create` requires title + start_time and fills the column defaults.
 * `update` validates ONLY the keys present in the body (a partial edit), and
 * never knows about status / created_by / recap / password — those are not
 * event "fields" and no caller of this module can set them.
 *
 * Cross-field ordering (end after start) is checked by the caller, because an
 * update may change one side and must be checked against the stored other side.
 */

/** Generous ceilings — a guard against absurd payloads, not a content policy. */
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 5000;
export const MAX_LOCATION = 300;
export const MAX_CATEGORY = 60;
/** integer column ceiling in Postgres — larger values would 500 on write */
const MAX_CAPACITY = 2147483647;

export interface EventFields {
  title?: string;
  start_time?: string;
  /** null = no explicit end: the meeting ends at the end of its Pacific day. */
  end_time?: string | null;
  description?: string | null;
  location?: string | null;
  category?: string;
  capacity?: number | null;
}

export type EventFieldsResult = { ok: true; fields: EventFields } | { ok: false; error: string };

/** Trimmed string, or null for absent / non-string / empty-after-trim. */
export function optionalText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseEventFields(body: Record<string, unknown>, mode: 'create' | 'update'): EventFieldsResult {
  const has = (k: string) => mode === 'create' || Object.prototype.hasOwnProperty.call(body, k);
  const fields: EventFields = {};

  if (has('title')) {
    const title = optionalText(body.title);
    if (!title) return { ok: false, error: mode === 'create' ? 'title and start_time are required' : 'title cannot be empty' };
    if (title.length > MAX_TITLE) return { ok: false, error: `title must be ${MAX_TITLE} characters or fewer` };
    fields.title = title;
  }

  if (has('start_time')) {
    const start = optionalText(body.start_time);
    if (!start) return { ok: false, error: mode === 'create' ? 'title and start_time are required' : 'start_time cannot be empty' };
    // Validate only — the raw string is what gets written, so Postgres keeps
    // doing the timestamptz parsing it already did.
    if (Number.isNaN(Date.parse(start))) return { ok: false, error: 'start_time is not a valid date and time' };
    fields.start_time = start;
  }

  if (has('end_time')) {
    const end = optionalText(body.end_time);
    if (end !== null && Number.isNaN(Date.parse(end))) {
      return { ok: false, error: 'end_time is not a valid date and time' };
    }
    fields.end_time = end; // null clears it: the meeting ends with its day
  }

  if (has('description')) {
    const description = optionalText(body.description);
    if (description !== null && description.length > MAX_DESCRIPTION) {
      return { ok: false, error: `description must be ${MAX_DESCRIPTION} characters or fewer` };
    }
    fields.description = description;
  }

  if (has('location')) {
    const location = optionalText(body.location);
    if (location !== null && location.length > MAX_LOCATION) {
      return { ok: false, error: `location must be ${MAX_LOCATION} characters or fewer` };
    }
    fields.location = location;
  }

  if (has('category')) {
    const category = optionalText(body.category) ?? 'meeting';
    if (category.length > MAX_CATEGORY) return { ok: false, error: `category must be ${MAX_CATEGORY} characters or fewer` };
    fields.category = category;
  }

  // capacity: absent / null / '' means "no cap". Anything else must be a real
  // positive integer (the old parseInt turned "abc" into NaN and wrote it).
  if (has('capacity')) {
    const raw = body.capacity;
    let capacity: number | null = null;
    if (raw !== undefined && raw !== null && raw !== '') {
      const parsed =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_CAPACITY) {
        return { ok: false, error: 'capacity must be a positive whole number' };
      }
      capacity = parsed;
    }
    fields.capacity = capacity;
  }

  return { ok: true, fields };
}
