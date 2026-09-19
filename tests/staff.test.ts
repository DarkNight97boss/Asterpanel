import assert from "node:assert/strict";
import { test } from "node:test";
import { AREA_HOME, STAFF_AREAS, STAFF_ROLES, staffAreas, staffCan } from "../src/lib/staff";

test("staff roles open only their areas; admins everything, clients nothing", () => {
  assert.deepEqual(staffAreas({ role: "admin", staffRole: "" }), STAFF_AREAS);
  assert.deepEqual(staffAreas({ role: "client", staffRole: "manager" }), [], "a leftover staff role on a client account grants nothing");
  assert.deepEqual(staffAreas(null), []);
  assert.deepEqual(staffAreas({ role: "staff", staffRole: "" }), STAFF_AREAS, "staff from before roles existed keep what they had");

  const can = (staffRole: (typeof STAFF_ROLES)[number], area: (typeof STAFF_AREAS)[number]) => staffCan({ role: "staff", staffRole }, area);
  assert.deepEqual([can("support", "support"), can("support", "clients"), can("support", "billing"), can("support", "platform")], [true, true, false, false]);
  assert.deepEqual([can("billing", "billing"), can("billing", "support"), can("billing", "platform")], [true, false, false]);
  assert.deepEqual([can("ops", "platform"), can("ops", "billing")], [true, false]);
  assert.deepEqual(STAFF_AREAS.filter((a) => can("content", a)), ["content"]);

  // Every role has somewhere to land, so a closed area can never redirect in a loop.
  for (const r of STAFF_ROLES) assert.ok(AREA_HOME[staffAreas({ role: "staff", staffRole: r })[0]].startsWith("/admin/"));
});
