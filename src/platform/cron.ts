/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week) in
 * UTC, plus the usual @hourly/@daily/@weekly/@monthly. Dependency-free: shared
 * by the control plane (validation) and the agent (scheduling).
 */

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const MACROS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *" };

export type CronSchedule = { minute: Set<number>; hour: Set<number>; dayOfMonth: Set<number>; month: Set<number>; dayOfWeek: Set<number>; domStar: boolean; dowStar: boolean };

function field(text: string, [min, max]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    const [lo, hi] = m[1] === "*" ? [min, max] : m[1].includes("-") ? m[1].split("-").map(Number) : [Number(m[1]), m[2] ? max : Number(m[1])];
    if (step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export function parseCron(expression: string): CronSchedule | null {
  const text = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => field(p, RANGES[i]));
  if (sets.some((s) => !s)) return null;
  const [minute, hour, dayOfMonth, month, dow] = sets as Set<number>[];
  // 7 is Sunday too.
  const dayOfWeek = new Set([...dow].map((d) => d % 7));
  return { minute, hour, dayOfMonth, month, dayOfWeek, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

/** True when `at` (to the minute, UTC) matches. Day-of-month and day-of-week are OR-ed when both are restricted, as in cron. */
export function cronMatches(s: CronSchedule, at: Date): boolean {
  if (!s.minute.has(at.getUTCMinutes()) || !s.hour.has(at.getUTCHours()) || !s.month.has(at.getUTCMonth() + 1)) return false;
  const dom = s.dayOfMonth.has(at.getUTCDate());
  const dow = s.dayOfWeek.has(at.getUTCDay());
  return s.domStar && s.dowStar ? true : s.domStar ? dow : s.dowStar ? dom : dom || dow;
}

export type CronJob = { schedule: string; command: string };

// One job per line, schedule first: "0 3 * * * node scripts/task.js". Blank lines and # comments are skipped.
// Throws a message meant for the user.
export function parseCronLines(text: string, max = 5): CronJob[] {
  const jobs: CronJob[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
    if (!m || !parseCron(m[1])) throw new Error(`Not a valid schedule: “${line.slice(0, 60)}”`);
    if (m[2].length > 500 || /[\0-\x1f]/.test(m[2])) throw new Error("A command is too long or contains control characters");
    jobs.push({ schedule: m[1].replace(/\s+/g, " "), command: m[2] });
  }
  if (jobs.length > max) throw new Error(`Up to ${max} scheduled jobs per app`);
  return jobs;
}
