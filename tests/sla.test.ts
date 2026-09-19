import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SLA, slaState } from "../src/lib/sla";

test("response targets: the clock runs only while the customer waits, by priority", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const high = slaState({ status: "open", priority: "high", lastReplyAt: at(5) }, DEFAULT_SLA, now);
  assert.deepEqual([high.waiting, high.breached, Math.round(high.hoursLeft)], [true, true, -1]);
  const medium = slaState({ status: "customer_reply", priority: "medium", lastReplyAt: at(5) }, DEFAULT_SLA, now);
  assert.deepEqual([medium.breached, Math.round(medium.hoursLeft), medium.dueAt?.toISOString()], [false, 19, "2026-09-21T07:00:00.000Z"]);
  for (const status of ["answered", "closed", "on_hold"]) assert.deepEqual(slaState({ status, priority: "high", lastReplyAt: at(500) }, DEFAULT_SLA, now), { waiting: false, dueAt: null, breached: false, hoursLeft: 0 }, status);
  assert.equal(slaState({ status: "open", priority: "low", lastReplyAt: at(47) }, { low: 48, medium: 24, high: 4 }, now).breached, false);
});
