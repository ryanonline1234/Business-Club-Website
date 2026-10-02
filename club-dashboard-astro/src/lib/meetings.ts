/**
 * Server helpers shared by the meetings archive pages (/meetings and
 * /meetings/[id]). Pure — no queries live here; the pages own their selects.
 */
import { PUBLIC_SUPABASE_URL } from './env';
import { pacificParts } from './event-time';

/** A missing column — the STEP 16–20 additions may land after a code deploy. */
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204');
}

/** A missing table or embed relationship (photos before STEP 18). */
export function isMissingRelation(error: { code?: string } | null | undefined): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST200');
}

/**
 * Public object URL for a club photo — the club-photos bucket is public-read
 * by design. storage_path is server-generated (photos/<uuid>.<ext>) but is
 * still treated as data: each segment is encoded, same as /about.
 */
export function photoUrl(path: string): string {
  return `${PUBLIC_SUPABASE_URL}/storage/v1/object/public/club-photos/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

/** "2026–27": the school year (August–July) a meeting falls in, by its Pacific date. */
export function schoolYearLabel(startIso: string): string {
  const { y, m } = pacificParts(Date.parse(startIso));
  const first = m >= 8 ? y : y - 1;
  return `${first}–${String((first + 1) % 100).padStart(2, '0')}`;
}

/** Plain-text paragraphs: each line break starts a new paragraph (recaps). */
export function paragraphs(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const EVENT_CATEGORIES = ['meeting', 'workshop', 'speaker', 'social', 'deadline'];

export function categoryLabel(c: string | null | undefined): string {
  const t = (c ?? '').trim() || 'meeting';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
