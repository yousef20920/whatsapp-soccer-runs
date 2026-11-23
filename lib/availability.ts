import { sql } from "./db.js";
import { addDays, torontoToDate, torontoToday } from "./time.js";
import { ALL_RESOURCE_IDS, fieldCost, type FieldCost, type Venue, VENUES } from "./venues.js";

const API = "https://anc.ca.apm.activecommunities.com/activemississauga/rest/reservation/resource/availability/daily";
const CACHE_MINUTES = 15;
const BOOKING_WINDOW_DAYS = 30; // online bookings: at least 24 hours and at most 30 days ahead
const MIN_NOTICE_MS = 24 * 60 * 60 * 1000;

export interface Window {
  start: number; // minutes after midnight, Toronto time
  end: number;
}
type Days = Record<string, Window[]>;

export interface Snapshot {
  byResource: Map<number, Days>;
  oldestFetch: Date;
  stale: boolean;
}

const toMinutes = (time: string, isEnd: boolean) => {
  const [h, m] = time.split(":").map(Number);
  const minutes = h * 60 + m;
  return isEnd && minutes === 0 ? 24 * 60 : minutes; // "00:00" as an end time means midnight
};

async function fetchResource(id: number, from: string, to: string): Promise<Days> {
  const url = `${API}/${id}?start_date=${from}&end_date=${to}&customer_id=0&company_id=0&locale=en-US`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "SORY/1.0 (NASORY runs community soccer group)" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Active Mississauga ${id} answered ${res.status}`);
  const json = (await res.json()) as {
    body: { details: { daily_details: { date: string; times: { start_time: string; end_time: string; available: boolean }[] }[] } };
  };
  const days: Days = {};
  for (const day of json.body.details.daily_details) {
    days[day.date] = day.times
      .filter((t) => t.available)
      .map((t) => ({ start: toMinutes(t.start_time, false), end: toMinutes(t.end_time, true) }));
  }
  return days;
}

/** Openings for every field, refreshed from Active Mississauga at most every 15 minutes. */
export async function loadAvailability(): Promise<Snapshot> {
  const rows = await sql<{ resource_id: number; fetched_at: Date; days: Days }[]>`
    SELECT resource_id, fetched_at, days FROM facility_availability`;
  const cached = new Map(rows.map((r) => [r.resource_id, r]));
  const freshAfter = Date.now() - CACHE_MINUTES * 60_000;
  const needed = ALL_RESOURCE_IDS.filter((id) => !cached.has(id) || new Date(cached.get(id)!.fetched_at).getTime() < freshAfter);

  const today = torontoToday();
  const [from, to] = [addDays(today, 1), addDays(today, BOOKING_WINDOW_DAYS)];
  let stale = false;

  // Ask the City's site a few fields at a time, so SORY never hammers it.
  const fresh: { id: number; days: Days }[] = [];
  for (let i = 0; i < needed.length; i += 3) {
    const batch = await Promise.allSettled(needed.slice(i, i + 3).map(async (id) => ({ id, days: await fetchResource(id, from, to) })));
    for (const result of batch) {
      if (result.status === "fulfilled") fresh.push(result.value);
      else {
        console.error(result.reason);
        stale = true; // fall back to the last copy we have, if any
      }
    }
  }

  // Save one at a time: Supabase's transaction pooler stalls on overlapping queries from one client.
  const fetchedAt = new Date();
  for (const { id, days } of fresh) {
    await sql`
      INSERT INTO facility_availability (resource_id, fetched_at, days)
      VALUES (${id}, ${fetchedAt}, ${sql.json(days)})
      ON CONFLICT (resource_id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, days = EXCLUDED.days`;
    cached.set(id, { resource_id: id, fetched_at: fetchedAt, days });
  }

  const byResource = new Map([...cached].map(([id, row]) => [id, row.days]));
  const fetchTimes = [...cached.values()].map((r) => new Date(r.fetched_at).getTime());
  return { byResource, oldestFetch: new Date(Math.min(...fetchTimes, Date.now())), stale };
}

function intersect(a: Window[], b: Window[]): Window[] {
  const out: Window[] = [];
  for (const x of a) for (const y of b) {
    const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

export type Size = "quarter" | "half" | "full";

export interface Slot {
  venue: Venue;
  label: string; // "F1+F2"
  resourceIds: number[];
  start: number; // minutes after midnight, Toronto time
  cost: FieldCost; // for the requested length from start
}

/**
 * Every bookable start on one day for the given field size, length and earliest start: the first
 * possible start in each free window, then every hour on the hour after it. Earliest first.
 */
export function findSlots(snapshot: Snapshot, ymd: string, size: Size, lengthMinutes: number, afterMinute: number): Slot[] {
  const slots: Slot[] = [];
  const earliestBookable = Date.now() + MIN_NOTICE_MS;
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const bookable = (start: number) => torontoToDate([y, m, d], [Math.floor(start / 60) % 24, start % 60]).getTime() >= earliestBookable;

  for (const venue of VENUES) {
    const groups = venue.outdoor
      ? venue.quarters.map((q) => [q.id]) // a whole outdoor field suits any format
      : size === "quarter" ? venue.quarters.map((q) => [q.id]) : size === "half" ? venue.halves.map((h) => [...h]) : [venue.quarters.map((q) => q.id)];

    for (const ids of groups) {
      const perField = ids.map((id) => snapshot.byResource.get(id)?.[ymd]);
      if (perField.some((w) => !w)) continue;
      const windows = perField.slice(1).reduce((acc, w) => intersect(acc!, w!), perField[0])!;
      const label = size === "full" && !venue.outdoor ? "Full field" : ids.map((id) => venue.quarters.find((q) => q.id === id)!.label).join("+");

      for (const open of windows) {
        let first = Math.ceil(Math.max(open.start, afterMinute) / 15) * 15;
        while (first + lengthMinutes <= open.end && !bookable(first)) first += 15;
        for (let start = first; start + lengthMinutes <= open.end; start = start === first ? Math.floor(first / 60) * 60 + 60 : start + 60) {
          slots.push({ venue, label, resourceIds: ids, start, cost: fieldCost(venue, ymd, start, lengthMinutes, ids.length) });
        }
      }
    }
  }
  return slots.sort((a, b) => a.start - b.start || a.cost.totalCents - b.cost.totalCents);
}

/** True when every field in `resourceIds` is free for the whole game. */
export function isOpen(snapshot: Snapshot, resourceIds: number[], ymd: string, startMinute: number, lengthMinutes: number): boolean {
  return resourceIds.every((id) =>
    (snapshot.byResource.get(id)?.[ymd] ?? []).some((w) => w.start <= startMinute && w.end >= startMinute + lengthMinutes),
  );
}
