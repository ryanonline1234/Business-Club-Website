/**
 * Event forms — the client half shared by /calendar's "New event" composer and
 * /meetings/[id]'s "Edit details" form, so the two can never disagree about
 * how a time is read or what gets sent. Imported from page <script>s (Astro
 * bundles it). No data is ever rendered into DOM HTML here — textContent and
 * input values only.
 *
 * • "Starts" is a datetime-local read as PACIFIC wall time on every device
 *   (the club's clock, and what the server prefills), converted to UTC with
 *   the same Intl guess-and-correct as lib/event-time on the server.
 * • "Ends" is a TIME on the start's day — meetings end the day of (owner
 *   decision, 2026-10-01). It follows the start at +1 h until the officer
 *   touches it. Blank means the meeting ends at midnight (lib/event-time); a
 *   time at or before the start is refused rather than rolled into the next
 *   day.
 * • An empty datetime-local shows a ghost of today's date in WebKit that reads
 *   like a real value (the owner once submitted it), so the New event form
 *   prefills Starts with the next round hour — the visible value is the real
 *   value. An untouched prefill is refreshed on reopen; anything typed is
 *   never clobbered.
 */

export const p2 = (n: number) => String(n).padStart(2, '0');

/* Form times are PACIFIC wall time on every device — the club's clock, and
   what the server prefills — not the device's own zone. Same guess-and-
   correct as lib/event-time on the server (Intl knows DST). */
const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
export const ptParts = (ms: number) => {
  const p: Record<string, string> = {};
  for (const x of PT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
};
const ptOffset = (ms: number) => {
  const w = ptParts(ms);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
};
/** Pacific wall time → UTC ms. */
const ptWallToMs = (y: number, m: number, d: number, h: number, mi: number) => {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - ptOffset(guess);
  const second = guess - ptOffset(first);
  return second !== first ? second : first;
};
/** "YYYY-MM-DDTHH:MM" (+ optional "HH:MM" on that date) → UTC ms, or NaN. */
export const parseWall = (dateTime: string, time?: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateTime);
  if (!m) return Number.NaN;
  const [hh, mm] = time ? time.split(':').map(Number) : [Number(m[4]), Number(m[5])];
  if (Number.isNaN(hh) || Number.isNaN(mm)) return Number.NaN;
  return ptWallToMs(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm);
};

/** "HH:MM" one wall-clock hour after a datetime-local value; '' past midnight.
 *  Wall-clock (not epoch) arithmetic, so the fall-back hour can't produce an
 *  end equal to the start. */
export const hourAfter = (startValue: string): string => {
  const m = /T(\d{2}):(\d{2})/.exec(startValue);
  if (!m) return '';
  const h = Number(m[1]) + 1;
  if (h > 23) return '';
  return `${p2(h)}:${m[2]}`;
};

export const readEventForm = (
  f: HTMLFormElement
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } => {
  const fd = new FormData(f);
  const title = String(fd.get('title') ?? '').trim();
  const startRaw = String(fd.get('start') ?? '');
  const endRaw = String(fd.get('end') ?? '').trim();
  if (!title || !startRaw) return { ok: false, error: 'A title and a start time are required.' };
  const startMs = parseWall(startRaw);
  if (Number.isNaN(startMs)) return { ok: false, error: 'The start time is not a valid date.' };
  const startDate = new Date(startMs);
  let endIso: string | null = null;
  if (endRaw) {
    const endMs = parseWall(startRaw, endRaw);
    if (Number.isNaN(endMs)) return { ok: false, error: 'The end time is not valid.' };
    const endDate = new Date(endMs);
    if (endDate.getTime() <= startDate.getTime()) {
      return {
        ok: false,
        error: 'The end time must be after the start — meetings end the same day. Leave it blank to end at midnight.',
      };
    }
    endIso = endDate.toISOString();
  }
  return {
    ok: true,
    payload: {
      title,
      start_time: startDate.toISOString(),
      end_time: endIso,
      location: String(fd.get('location') ?? '').trim(),
      description: String(fd.get('description') ?? '').trim(),
      category: String(fd.get('category') ?? 'meeting'),
      // '' means "no cap" to the endpoint; anything else must be a positive
      // integer, which the endpoint validates.
      capacity: String(fd.get('capacity') ?? '').trim(),
      // Only the meeting page's Edit form has a slides field; '' clears it.
      ...(f.querySelector('input[name="slides"]') ? { slides_url: String(fd.get('slides') ?? '').trim() } : {}),
    },
  };
};

/** Keep Ends at Starts + 1 h until the officer edits Ends. Returns a re-sync hook. */
export const wireEndToStart = (f: HTMLFormElement) => {
  const startIn = f.querySelector('input[name="start"]') as HTMLInputElement | null;
  const endIn = f.querySelector('input[name="end"]') as HTMLInputElement | null;
  if (!startIn || !endIn) return () => {};
  // Edit form: a stored end of exactly start + 1 h keeps following; any other
  // stored end (or a stored blank = "midnight") is the officer's choice.
  let endTouched = endIn.value !== hourAfter(startIn.value);
  if (!startIn.value) endTouched = false;
  // The hint states what will actually be saved, from the field's VALUE (a
  // WebKit placeholder can look like a time while the value is empty).
  const hint = f.querySelector('.js-end-hint') as HTMLElement | null;
  const fmt12 = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const updateHint = () => {
    if (!hint) return;
    hint.textContent = endIn.value
      ? `Ends ${fmt12(endIn.value)}, same day as the start.`
      : 'No end time — the meeting ends at midnight that day.';
  };
  endIn.addEventListener('input', () => {
    endTouched = true;
    updateHint();
  });
  const sync = () => {
    if (!endTouched) endIn.value = hourAfter(startIn.value);
    updateHint();
  };
  updateHint();
  startIn.addEventListener('input', sync);
  startIn.addEventListener('change', sync);
  return sync;
};

export const bindEventForm = (
  f: HTMLFormElement,
  send: (payload: Record<string, unknown>) => Promise<Response>,
  failMsg: string,
  onOk: (res: Response) => unknown = () => location.reload()
) => {
  const errEl = f.querySelector('.js-form-error') as HTMLElement | null;
  const showErr = (msg: string) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
  };
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (errEl) errEl.style.display = 'none';
    const read = readEventForm(f);
    if (!read.ok) {
      showErr(read.error);
      return;
    }
    const submitBtn = f.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitBtn.disabled = true;
    try {
      const res = await send(read.payload);
      if (!res.ok) {
        let msg = failMsg;
        try {
          const body = await res.json();
          if (body && typeof body.error === 'string') msg = body.error;
        } catch {
          /* non-JSON error body — keep the fallback message */
        }
        showErr(msg);
        return;
      }
      await onOk(res);
    } catch {
      showErr('Network error — check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
};

/**
 * /calendar's New event composer: prefill the start, wire the end, POST.
 * On success it lands on the new event — its meeting page when the officer
 * came from /meetings ("Add a past meeting"), else the calendar with it
 * selected — instead of reloading onto whatever was selected before.
 */
export function wireCreateForm(form: HTMLFormElement, opts: { landOnMeetingPage?: boolean } = {}): void {
  const startInput = form.querySelector('input[name="start"]') as HTMLInputElement | null;
  const syncEnd = wireEndToStart(form);
  let lastPrefill = '';
  const prefillStart = () => {
    if (!startInput) return;
    if (startInput.value && startInput.value !== lastPrefill) return;
    // The next round hour, in Pacific wall time (Date.UTC rolls the day).
    const w = ptParts(Date.now());
    const n = new Date(Date.UTC(w.y, w.m - 1, w.d, w.h + 1));
    lastPrefill = `${n.getUTCFullYear()}-${p2(n.getUTCMonth() + 1)}-${p2(n.getUTCDate())}T${p2(n.getUTCHours())}:00`;
    startInput.value = lastPrefill;
    syncEnd();
  };
  const composerEl = form.closest('details');
  if (composerEl) {
    composerEl.addEventListener('toggle', () => {
      if (composerEl.open) prefillStart();
    });
    if (composerEl.open) prefillStart();
  } else {
    prefillStart();
  }
  bindEventForm(
    form,
    (payload) =>
      fetch('/api/events/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    'Could not create the event.',
    async (res) => {
      const body = await res.json().catch(() => null);
      const id = body && body.data && typeof body.data.id === 'string' ? (body.data.id as string) : null;
      if (!id) return location.reload();
      location.href = opts.landOnMeetingPage
        ? `/meetings/${encodeURIComponent(id)}`
        : `/calendar?event=${encodeURIComponent(id)}`;
    }
  );
}

/** /meetings/[id]'s Edit details form: wire the end, PATCH only what changed in time. */
export function wireEditForm(form: HTMLFormElement): void {
  const editId = form.dataset.eventId ?? '';
  wireEndToStart(form);
  form.querySelector('.js-edit-close')?.addEventListener('click', () => {
    const d = form.closest('details');
    if (d) d.open = false;
  });
  bindEventForm(
    form,
    (payload) => {
      // Times the officer didn't touch aren't re-sent: a title-only fix can
      // never move the meeting, and a legacy end on another day (prefilled
      // blank) isn't silently cleared.
      const sIn = form.querySelector('input[name="start"]') as HTMLInputElement | null;
      const eIn = form.querySelector('input[name="end"]') as HTMLInputElement | null;
      if (sIn && eIn && sIn.value === sIn.defaultValue && eIn.value === eIn.defaultValue) {
        delete payload.start_time;
        delete payload.end_time;
      }
      return fetch(`/api/events/${encodeURIComponent(editId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    },
    'Could not save the event.'
  );
}
