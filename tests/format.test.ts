import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeBlocks, safeHref } from "../src/cms/blocks";
import { addCycle, DOMAIN_RE, parseMoney, slugify } from "../src/lib/format";

test("addCycle clamps month ends", () => {
  assert.equal(addCycle(new Date("2026-01-31T00:00:00Z"), "monthly")?.toISOString().slice(0, 10), "2026-02-28");
  assert.equal(addCycle(new Date("2026-03-15T00:00:00Z"), "annually")?.toISOString().slice(0, 10), "2027-03-15");
  assert.equal(addCycle(new Date(), "onetime"), null);
});

test("parseMoney", () => {
  assert.equal(parseMoney("12,5"), 1250);
  assert.equal(parseMoney("0.07"), 7);
  assert.equal(parseMoney("1.999"), null);
  assert.equal(parseMoney("abc"), null);
});

test("slugify and domains", () => {
  assert.equal(slugify("  Hosting Più Veloce! "), "hosting-piu-veloce");
  assert.ok(DOMAIN_RE.test("sub.example.co.uk"));
  assert.ok(!DOMAIN_RE.test("-bad.com"));
  assert.ok(!DOMAIN_RE.test("nodot"));
});

test("editor input is sanitised", () => {
  const blocks = sanitizeBlocks([
    { id: "a", type: "hero", props: { title: "Hi", align: "diagonal", evil: "<script>" } },
    { type: "unknown", props: {} },
    "garbage",
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].props.align, "center");
  assert.ok(!("evil" in blocks[0].props));
  assert.equal(safeHref("javascript:alert(1)"), "#");
  assert.equal(safeHref("/ok"), "/ok");
});
