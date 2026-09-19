import assert from "node:assert/strict";
import { test } from "node:test";
import { cronMatches, parseCron, parseCronLines } from "../src/platform/cron";

const at = (iso: string) => new Date(iso);
const hits = (expr: string, iso: string) => cronMatches(parseCron(expr)!, at(iso));

test("cron expressions: fields, steps, ranges, lists, macros and the day-of-month / day-of-week rule", () => {
  assert.ok(hits("* * * * *", "2026-09-19T10:37:00Z"));
  assert.deepEqual(["10:00", "10:15", "10:20", "10:45"].map((t) => hits("*/15 * * * *", `2026-09-19T${t}:00Z`)), [true, true, false, true]);
  assert.deepEqual([hits("30 3 * * *", "2026-09-19T03:30:00Z"), hits("30 3 * * *", "2026-09-19T03:31:00Z"), hits("30 3 * * *", "2026-09-19T15:30:00Z")], [true, false, false]);
  assert.deepEqual([hits("0 9-17/4 * * 1-5", "2026-09-21T13:00:00Z"), hits("0 9-17/4 * * 1-5", "2026-09-20T13:00:00Z"), hits("0 9-17/4 * * 1-5", "2026-09-21T14:00:00Z")], [true, false, false], "Monday 13:00 yes, Sunday no, 14:00 no");
  assert.deepEqual([hits("0 0 1,15 * *", "2026-09-15T00:00:00Z"), hits("0 0 1,15 * *", "2026-09-16T00:00:00Z")], [true, false]);
  assert.ok(hits("0 0 * * 7", "2026-09-20T00:00:00Z"), "7 is Sunday");
  // Both restricted: either one is enough, as in every cron.
  assert.deepEqual([hits("0 0 13 * 5", "2026-11-13T00:00:00Z"), hits("0 0 13 * 5", "2026-09-13T00:00:00Z"), hits("0 0 13 * 5", "2026-09-18T00:00:00Z"), hits("0 0 13 * 5", "2026-09-14T00:00:00Z")], [true, true, true, false]);
  assert.deepEqual([hits("@daily", "2026-09-19T00:00:00Z"), hits("@hourly", "2026-09-19T07:00:00Z"), hits("@weekly", "2026-09-20T00:00:00Z"), hits("@monthly", "2026-10-01T00:00:00Z"), hits("@daily", "2026-09-19T00:01:00Z")], [true, true, true, true, false]);
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1,,2 * * * *", "@yearlyish", "* * * * * ; rm -rf /"]) assert.equal(parseCron(bad), null, bad);
});

test("cron lines: schedule and command are split safely, with limits", () => {
  assert.deepEqual(parseCronLines("# nightly\n\n  */5  *  * * *   node scripts/sync.js --all\n@daily php artisan schedule:run\n"), [{ schedule: "*/5 * * * *", command: "node scripts/sync.js --all" }, { schedule: "@daily", command: "php artisan schedule:run" }]);
  assert.throws(() => parseCronLines("every day do stuff"), /Not a valid schedule/);
  assert.throws(() => parseCronLines("* * * * *"), /Not a valid schedule/, "a schedule without a command");
  assert.throws(() => parseCronLines(`* * * * * ${"x".repeat(501)}`), /too long/);
  assert.throws(() => parseCronLines(Array(6).fill("@daily true").join("\n")), /Up to 5/);
});
