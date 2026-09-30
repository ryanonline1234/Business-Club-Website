import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The per-meeting attendance sheet officers download from /attendance and
 * /calendar (GET /api/events/:id/attendance.pdf). Pure: data in, bytes out —
 * no database, no request — so it can be rendered and eyeballed locally.
 *
 * FONTS: the built-in Helvetica, deliberately. It needs no font file (the
 * @fontsource packages ship per-script woff2 subsets, so no single one of them
 * would cover every name anyway). Its catch is WinAnsi: it covers Western
 * accents (é, ñ, ü, ç, ø…) but THROWS on anything else ("ễ", "ł", CJK). So
 * every string goes through pdfSafe() first — accents it can't draw are
 * stripped to their base letter, and what is left falls back to "?". Emails
 * are never character-substituted, and a long one shrinks (down to 7pt)
 * before it is ever truncated, so every row stays identifiable.
 */

export interface AttendanceSheetEvent {
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  status: string;
}

export interface AttendanceSheetRow {
  name: string | null;
  email: string;
  checked_in_at: string;
}

const TZ = 'America/Los_Angeles';

/** YYYY-MM-DD of the meeting, Pacific — the filename and the sheet's key. */
export function meetingDateKey(startIso: string): string {
  return new Date(startIso).toLocaleDateString('en-CA', { timeZone: TZ });
}

const fmtLongDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const fmtStamp = (d: Date) =>
  d.toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

/** No Unicode decomposition exists for these, so NFD alone can't rescue them. */
const FALLBACK: Record<string, string> = {
  // ICU (Node 20+) puts U+202F between a time and "PM"; WinAnsi has no such
  // space, and an unmapped one would print "6:42?PM".
  '\u202f': ' ', '\u2009': ' ', '\u2007': ' ', '\u200a': ' ', '\u2002': ' ', '\u2003': ' ',
  'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', 'ħ': 'h', 'Ħ': 'H',
  'ŋ': 'n', 'Ŋ': 'N', 'ſ': 's', 'ĸ': 'k',
};

function makePdfSafe(font: PDFFont) {
  const allowed = new Set(font.getCharacterSet());
  return (value: string): string => {
    let out = '';
    for (const ch of value.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ')) {
      const cp = ch.codePointAt(0)!;
      if (allowed.has(cp)) { out += ch; continue; }
      if (FALLBACK[ch]) { out += FALLBACK[ch]; continue; }
      // Strip combining marks the font can't draw: "ễ" → "e", "č" → "c";
      // NFKD also unfolds compatibility forms ("ﬁ" → "fi", "Ǆ" → "DZ").
      const base = ch.normalize('NFKD').replace(/\p{M}+/gu, '');
      // A lone combining mark NFC couldn't fold into its letter: drop it.
      if (!base) continue;
      out += [...base].every((b) => allowed.has(b.codePointAt(0)!)) ? base : '?';
    }
    return out;
  };
}

/** Trim `text` with an ellipsis until it fits `maxWidth` at `size`. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// Letter, 0.75" margins. Colours echo the portal: ink, gold rule, bone zebra.
const PAGE: [number, number] = [612, 792];
const M = 54;
const INK = rgb(0.141, 0.122, 0.098);    // #241F19
const INK_3 = rgb(0.42, 0.39, 0.35);
const GOLD = rgb(0.557, 0.482, 0.282);   // #8E7B48
const ZEBRA = rgb(0.957, 0.941, 0.902);  // #F4F0E6

const COL = { num: M, name: M + 30, email: M + 232, timeRight: PAGE[0] - M };
const NAME_W = COL.email - COL.name - 12;
const EMAIL_W = COL.timeRight - 70 - COL.email;
const ROW_H = 19;

export async function buildAttendancePdf(
  event: AttendanceSheetEvent,
  rows: AttendanceSheetRow[],
  generatedAt: Date
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = makePdfSafe(regular); // Helvetica and its bold share WinAnsi

  const dateKey = meetingDateKey(event.start_time);
  const longDate = fmtLongDate(event.start_time);
  doc.setTitle(`Mitty Business Club Attendance ${dateKey}`);
  doc.setAuthor('Mitty Business Club');
  doc.setSubject(safe(event.title));
  doc.setCreator('mittybusinessclub.vercel.app');
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);

  // Alphabetical by display name (falling back to email), case-insensitive.
  const sorted = [...rows].sort((a, b) =>
    (a.name?.trim() || a.email).localeCompare(b.name?.trim() || b.email, 'en', { sensitivity: 'base' })
  );

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  // Every string drawn goes through safe() here, so nothing can throw at draw
  // time. Anything MEASURED (fit, right-alignment) must be made safe first.
  const text = (p: PDFPage, s: string, x: number, yy: number, size: number, font = regular, color = INK) =>
    p.drawText(safe(s), { x, y: yy, size, font, color });

  const tableHead = () => {
    text(page, '#', COL.num, y, 8.5, bold, INK_3);
    text(page, 'NAME', COL.name, y, 8.5, bold, INK_3);
    text(page, 'EMAIL', COL.email, y, 8.5, bold, INK_3);
    const w = bold.widthOfTextAtSize('CHECKED IN', 8.5);
    text(page, 'CHECKED IN', COL.timeRight - w, y, 8.5, bold, INK_3);
    y -= 7;
    page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 0.6, color: INK_3 });
    y -= ROW_H - 4;
  };

  const newPage = (first: boolean) => {
    page = doc.addPage(PAGE);
    pages.push(page);
    y = PAGE[1] - M;
    if (first) {
      text(page, 'MITTY BUSINESS CLUB', M, y, 9, bold, GOLD);
      y -= 26;
      text(page, fit(safe(`Attendance — ${longDate}`), bold, 20, PAGE[0] - 2 * M), M, y, 20, bold);
      y -= 20;
      const when = event.end_time
        ? `${fmtTime(event.start_time)} – ${fmtTime(event.end_time)}`
        : fmtTime(event.start_time);
      const line = [event.title, when, event.location].filter(Boolean).join('  ·  ');
      text(page, fit(safe(line), regular, 11, PAGE[0] - 2 * M), M, y, 11, regular, INK_3);
      y -= 18;
      const countLine =
        `${rows.length} ${rows.length === 1 ? 'attendee' : 'attendees'}` +
        (event.status === 'cancelled' ? '   (this meeting was cancelled)' : '');
      text(page, countLine, M, y, 11, bold);
      y -= 12;
      page.drawLine({ start: { x: M, y }, end: { x: PAGE[0] - M, y }, thickness: 1.2, color: GOLD });
      y -= 24;
    } else {
      text(page, fit(safe(`Attendance — ${longDate} (continued)`), bold, 11, PAGE[0] - 2 * M), M, y, 11, bold, INK_3);
      y -= 24;
    }
    if (sorted.length > 0) tableHead();
  };

  newPage(true);

  if (sorted.length === 0) {
    text(page, 'No one checked in to this meeting.', M, y, 11, regular, INK_3);
  }

  sorted.forEach((r, i) => {
    if (y < M + 28) newPage(false);
    if (i % 2 === 1) {
      page.drawRectangle({ x: M - 4, y: y - 5, width: PAGE[0] - 2 * M + 8, height: ROW_H, color: ZEBRA });
    }
    const n = String(i + 1);
    text(page, n, COL.num + 14 - regular.widthOfTextAtSize(n, 10), y, 10, regular, INK_3);
    text(page, fit(safe(r.name?.trim() || '—'), regular, 10.5, NAME_W), COL.name, y, 10.5);
    // Emails are the row's identifier: shrink to fit (down to 7pt) before
    // resorting to an ellipsis, which then only hits absurdly long addresses.
    const em = safe(r.email);
    const emSize = Math.max(7, Math.min(9.5, (9.5 * EMAIL_W) / Math.max(1, regular.widthOfTextAtSize(em, 9.5))));
    text(page, fit(em, regular, emSize, EMAIL_W), COL.email, y, emSize, regular, INK_3);
    const t = safe(fmtTime(r.checked_in_at));
    text(page, t, COL.timeRight - regular.widthOfTextAtSize(t, 10), y, 10);
    y -= ROW_H;
  });

  // Footers last, once the page count is known.
  const stamp = safe(`Generated ${fmtStamp(generatedAt)} PT`);
  pages.forEach((p, i) => {
    const left = `Mitty Business Club · Attendance ${dateKey}`;
    const right = `${stamp} · Page ${i + 1} of ${pages.length}`;
    text(p, left, M, M - 24, 8, regular, INK_3);
    text(p, right, PAGE[0] - M - regular.widthOfTextAtSize(right, 8), M - 24, 8, regular, INK_3);
  });

  return doc.save();
}
