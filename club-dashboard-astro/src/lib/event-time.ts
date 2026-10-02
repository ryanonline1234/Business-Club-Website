/**
 * When a meeting starts, ends, and accepts check-ins — the ONE home of these
 * rules. Before this module the same constants were copied into five files
 * (docs/KNOWN-GAPS.md listed the drift risk); import from here instead.
 *
 * THE SAME-DAY RULE (owner decision, 2026-10-01): meetings end the day of.
 * An event with no end_time is not open-ended — it ends at the end of its
 * start's Pacific calendar day (11:59:59.999 PM, America/Los_Angeles). The
 * event form pre-fills an end one hour after the start; clearing it is how an
 * officer says "until the end of the day". An explicit end_time at or before
 * start_time is bad data and is treated as absent.
 *
 * Pacific maths without a date library: the server runs in UTC, so offsets
 * come from Intl (which knows DST) and midnight is found by guess-and-correct.
 */

export const CLUB_TZ = 'America/Los_Angeles';

/** Check-in opens this long before start_time. */
export const CHECKIN_OPENS_BEFORE_MS = 30 * 60 * 1000;
/** With an explicit end_time, check-in stays open this long after it. */
export const CHECKIN_CLOSES_AFTER_END_MS = 2 * 60 * 60 * 1000;

const wallFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: CLUB_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Pacific wall-clock parts of a UTC instant. */
export function pacificParts(ms: number) {
  const p: Record<string, string> = {};
  for (const part of wallFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Pacific wall time minus UTC, in ms, at a UTC instant (−7 h or −8 h). */
function offsetMs(ms: number): number {
  const w = pacificParts(ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of 00:00 Pacific on a Pacific calendar date. */
export function pacificMidnightUtcMs(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  let utc = guess - offsetMs(guess);
  const corrected = guess - offsetMs(utc); // the offset may differ across a DST edge
  if (corrected !== utc) utc = corrected;
  return utc;
}

/** Last millisecond of the Pacific calendar day containing `ms`. */
export function endOfPacificDayMs(ms: number): number {
  const w = pacificParts(ms);
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1)); // rolls months/years
  return pacificMidnightUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()) - 1;
}

/** "YYYY-MM-DD" Pacific day key — the same key every page buckets on. */
export function pacificDayKey(value: string | number | Date): string {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: CLUB_TZ });
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The explicit end in ms, or null when absent / unparseable / not after start. */
export function explicitEndMs(startTime: unknown, endTime: unknown): number | null {
  const start = parseMs(startTime);
  const end = parseMs(endTime);
  if (start === null || end === null || end <= start) return null;
  return end;
}

/** When the meeting is over: its end_time, or the end of its Pacific day. */
export function effectiveEndMs(startTime: unknown, endTime: unknown): number | null {
  const start = parseMs(startTime);
  if (start === null) return null;
  return explicitEndMs(start, endTime) ?? endOfPacificDayMs(start);
}

/**
 * The check-in window, or null when start_time is unusable (callers treat that
 * as a data problem, never as "open"). Opens 30 min before the start; closes
 * 2 h after an explicit end — but never past midnight that day (an 11 PM end
 * doesn't keep check-in open until 1 AM) — or, with no end, at the end of the
 * start's Pacific day. A legacy end on a LATER day (the old form allowed it)
 * keeps check-in open until that end, without the grace.
 */
export function checkinWindow(
  startTime: unknown,
  endTime: unknown
): { opensAt: number; closesAt: number } | null {
  const start = parseMs(startTime);
  if (start === null) return null;
  const dayEnd = endOfPacificDayMs(start);
  const end = explicitEndMs(start, endTime);
  const closesAt =
    end === null ? dayEnd : end <= dayEnd ? Math.min(end + CHECKIN_CLOSES_AFTER_END_MS, dayEnd) : end;
  return { opensAt: start - CHECKIN_OPENS_BEFORE_MS, closesAt };
}

/** Between the start and the (effective) end. */
export function isHappeningNow(startTime: unknown, endTime: unknown, nowMs = Date.now()): boolean {
  const start = parseMs(startTime);
  const end = effectiveEndMs(startTime, endTime);
  return start !== null && end !== null && nowMs >= start && nowMs <= end;
}
