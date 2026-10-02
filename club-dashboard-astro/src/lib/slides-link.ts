/**
 * The ONE place that decides whether a slides link is acceptable, and what it
 * is called. Used by PATCH /api/events/:id (write) and the meeting pages
 * (render — a stored value is re-checked every time it is shown).
 *
 * Owner decision (2026-10-01): one link per meeting, Google Slides / Docs /
 * Drive only, members-only (never selected by the public /about page).
 *
 * Why so strict:
 *   • https only — that alone rules out javascript:, data: and friends in an
 *     <a href>.
 *   • exact host allow-list — a host matches only exactly (no suffix games:
 *     "docs.google.com.evil.com" and "evilgoogle.com" both fail).
 *   • the LABEL is derived from the host here, never typed by an officer, so a
 *     link can't claim to be something it isn't.
 *   • no embedding anywhere: rendering a Google iframe would load third-party
 *     scripts into the portal (invariant 10). It is always a plain link.
 */

export const MAX_SLIDES_URL = 2048;

const DOCS_KINDS: [string, string][] = [
  ['/presentation/', 'Google Slides'],
  ['/document/', 'Google Docs'],
  ['/spreadsheets/', 'Google Sheets'],
  ['/forms/', 'Google Forms'],
];
const HOSTS: Record<string, (path: string) => string> = {
  'docs.google.com': (path) => DOCS_KINDS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'Google Docs',
  'drive.google.com': () => 'Google Drive',
};

export type SlidesLinkResult =
  | { ok: true; href: string; label: string; host: string }
  | { ok: false; error: string };

export function parseSlidesUrl(raw: string): SlidesLinkResult {
  const value = raw.trim();
  if (value.length > MAX_SLIDES_URL) return { ok: false, error: 'That link is too long.' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'That isn’t a link. Paste the share link from Google Slides, Docs or Drive.' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Use an https:// link.' };
  if (url.username || url.password || url.port) {
    return { ok: false, error: 'Paste the plain share link from Google Slides, Docs or Drive.' };
  }
  const host = url.hostname.toLowerCase();
  const labelFor = HOSTS[host];
  if (!labelFor) {
    return { ok: false, error: 'Only Google Slides, Docs and Drive links are allowed.' };
  }
  // url.href is what gets stored, and percent-encoding can lengthen it.
  if (url.href.length > MAX_SLIDES_URL) return { ok: false, error: 'That link is too long.' };
  return { ok: true, href: url.href, label: labelFor(url.pathname), host };
}

/** For rendering a STORED value: the link to show, or null if it no longer passes. */
export function slidesLink(stored: unknown): { href: string; label: string; host: string } | null {
  if (typeof stored !== 'string' || stored.trim() === '') return null;
  const r = parseSlidesUrl(stored);
  return r.ok ? { href: r.href, label: r.label, host: r.host } : null;
}
