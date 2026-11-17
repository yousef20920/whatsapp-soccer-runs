const ZONE = "America/Toronto";

/** "2026-11-21" -> [2026, 11, 21] */
export function parseDate(text: string): [number, number, number] | null {
  const m = text.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? [y, mo, d] : null;
}

/** "20:00", "8pm", "8:30 pm" -> [20, 0] */
export function parseTime(text: string): [number, number] | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? [hour, minute] : null;
}

/** Today's date in Toronto as YYYY-MM-DD. */
export function torontoToday(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: ZONE });
}

/** "2026-11-30" + 2 -> "2026-12-02" */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Sun, Nov 22" */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

/** 1290 -> "9:30 PM", 1440 -> "12:00 AM" */
export function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 1380 -> "11 PM", 1245 -> "8:45 PM", 1440 -> "12 AM" */
export function shortTime(minute: number): string {
  return minuteLabel(minute).replace(":00", "");
}

/** "Sat, Nov 28 · 8:00 PM EST" (EDT during daylight saving) */
export function torontoLabel(date: Date): string {
  const day = date.toLocaleDateString("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric" });
  const time = date.toLocaleTimeString("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${day} · ${time}`;
}

/** Minutes Toronto is ahead of UTC at a given instant (e.g. -300 in winter). */
function torontoOffsetMinutes(utcMs: number): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName")?.value;
  const m = name?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Toronto wall-clock date and time -> the real instant, handling daylight saving. */
export function torontoToDate([y, mo, d]: [number, number, number], [h, mi]: [number, number]): Date {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wallAsUtc - torontoOffsetMinutes(wallAsUtc) * 60_000;
  utc = wallAsUtc - torontoOffsetMinutes(utc) * 60_000;
  return new Date(utc);
}
