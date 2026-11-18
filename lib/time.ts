// Europe/Prague time helpers. Vercel functions run in UTC, so every local
// hour/weekday/HDO decision must go through these helpers, never Date#getHours().

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const TZ = "Europe/Prague";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// Prague's UTC offset only changes on whole hours, so cache it per UTC hour.
const offsetCache = new Map<number, number>();

/** Offset of Europe/Prague from UTC in minutes (60 in winter, 120 in summer). */
export function pragueOffsetMin(ms: number): number {
  const hourKey = Math.floor(ms / HOUR);
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(hourKey * HOUR))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = Math.round((asUtc - hourKey * HOUR) / MINUTE);
  if (offsetCache.size > 50_000) offsetCache.clear();
  offsetCache.set(hourKey, offset);
  return offset;
}

export interface LocalTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minuteOfDay: number; // 0-1439
  isoWeekday: number; // 1 = Monday … 7 = Sunday
}

export function pragueLocal(ms: number): LocalTime {
  const d = new Date(ms + pragueOffsetMin(ms) * MINUTE);
  const wd = d.getUTCDay();
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
    isoWeekday: wd === 0 ? 7 : wd,
  };
}

export function isWeekend(ms: number): boolean {
  return pragueLocal(ms).isoWeekday >= 6;
}

export const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE;
// Prague offsets are whole hours, so a UTC hour boundary is also a Prague hour boundary.
export const floorHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;
