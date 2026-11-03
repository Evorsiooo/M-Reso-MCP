const TZ = "Europe/Paris";

function parts(ms: number) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

/** Epoch ms -> "YYYY-MM-DDTHH:mm" in Grenoble local time. */
export function localIso(ms: number): string {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Epoch ms -> "HH:mm" in Grenoble local time. */
export function hhmm(ms: number): string {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

/**
 * Accepts "2026-11-03T18:30" (local), ISO with offset/Z, "2026-11-03 18:30",
 * or "18:30" (today, local). Returns local date + time as the API expects.
 */
export function toLocalDateTime(input: string, now: number = Date.now()): { date: string; time: string } {
  const s = input.trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const p = parts(now);
    return { date: `${p.year}-${p.month}-${p.day}`, time: s.padStart(5, "0") };
  }
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && /T/.test(s)) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) throw new Error(`Invalid date/time: ${input}`);
    const [date, time] = localIso(ms).split("T");
    return { date, time };
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (!m) throw new Error(`Invalid date/time "${input}". Use ISO like 2026-11-03T18:30 (Grenoble local time) or HH:mm.`);
  return { date: m[1], time: m[2] };
}
