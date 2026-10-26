/**
 * Meeting activities — the interactive pages a meeting runs (a game, demo
 * websites, a report card), served from this site at /activities/<slug>/
 * instead of from a third-party host.
 *
 * WHERE THEY LIVE. Each activity is a folder of plain HTML/CSS/JS under
 * src/activities/<slug>/ with an index.html; relative links between its files
 * work as written. The files are bundled into the server at build time
 * (import.meta.glob ?raw) and served by
 * src/pages/activities/[slug]/[...path].ts. Nothing is read from disk or the
 * database at request time, so a request can only ever name a file that is in
 * this bundle — there is no path to traverse. Fonts they need are self-hosted
 * in public/activity-assets/ (invariant 10: no Google Fonts, no CDNs).
 *
 * THEY ARE CODE, NOT CONTENT (AGENTS.md invariant 11). An activity runs on
 * this origin, beside the session cookie. The cookie is httpOnly, but a script
 * here could still call the API as whoever is viewing — so activities arrive
 * by commit and review like any other code, never by an officer upload. The
 * serving route adds a CSP (connect-src 'none', form-action 'none') as a
 * second line, not as the reason this is safe.
 *
 * AUDIENCE.
 *   'public'   — anyone with the link, no sign-in: what members open on their
 *                phones mid-meeting. Must hold nothing secret (no answer keys).
 *   'officers' — approved officers only (requireOfficer): presenter views and
 *                anything that holds the answers. Listed on a meeting page
 *                only for officers.
 *
 * MEETINGS. Which meetings list the activity, by events.id. Kept here rather
 * than in a database column (owner decision, 2026-10-26): adding an activity
 * already takes a commit, so attaching it costs nothing extra. Move it to a
 * column with a picker in Edit details once officers want to reuse activities
 * without a deploy.
 */

export type ActivityAudience = 'public' | 'officers';

export interface Activity {
  /** URL segment and folder name: src/activities/<slug>/ → /activities/<slug>/ */
  slug: string;
  title: string;
  /** One line under the title on a meeting page. */
  summary: string;
  audience: ActivityAudience;
  /** events.id of every meeting that lists this activity. */
  meetings: readonly string[];
}

/** "2nd Business Meeting", 2026-10-14 — the websites meeting. */
const WEBSITES_MEETING = '51ab2bae-f28e-4dd1-9666-edced601c39f';

export const ACTIVITIES: readonly Activity[] = [
  {
    slug: 'website-hunt',
    title: 'Website Hunt',
    summary: 'Team competition: find the 12 mistakes hidden on each of three made-up business websites.',
    audience: 'public',
    meetings: [WEBSITES_MEETING],
  },
  {
    slug: 'website-lab',
    title: 'Website Lab',
    summary: 'Presenter view: the same three websites with the answers revealed, their fixed versions, and the report card.',
    audience: 'officers',
    meetings: [WEBSITES_MEETING],
  },
];

/** Every activity file, keyed by its path relative to src/activities/. */
const FILES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../activities/**/*.{html,css,js}', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
  ).map(([path, body]) => [path.replace('../activities/', ''), body])
);

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

/** An activity only counts once its index.html is in the bundle. */
const isServable = (a: Activity) => `${a.slug}/index.html` in FILES;

export function findActivity(slug: string): Activity | null {
  return ACTIVITIES.find((a) => a.slug === slug && isServable(a)) ?? null;
}

/** One file of an activity, by its path inside the activity's folder. */
export function activityFile(activity: Activity, path: string): { body: string; type: string } | null {
  const body = FILES[`${activity.slug}/${path}`];
  const type = TYPES[path.slice(path.lastIndexOf('.') + 1)];
  return body === undefined || type === undefined ? null : { body, type };
}

export function activityHref(activity: Activity): string {
  return `/activities/${activity.slug}/`;
}

/** The activities a meeting page lists, in ACTIVITIES order. */
export function activitiesForMeeting(eventId: string, isOfficer: boolean): Activity[] {
  return ACTIVITIES.filter(
    (a) => a.meetings.includes(eventId) && isServable(a) && (a.audience === 'public' || isOfficer)
  );
}
