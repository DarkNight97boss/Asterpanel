import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

import { formatOptionLines, parseOptionLines, resolveOptions } from "../src/lib/product-options";

const LINES = "choice | Backups kept | 7 days = 0 ; 30 days = 3.00 ; 90 days = 8,00\nchoice | Memory | 1 GB = 0 ; 2 GB = 4.00 / 1024 ; 4 GB = 10.00 / 3072 / 5\n\nquantity | Extra disk (10 GB) | 2.00 | 0 | 20 | 0 | 10";

test("option lines: parsed, written back the same way, and refused when unclear", () => {
  const options = parseOptionLines(LINES);
  assert.deepEqual(options.map((o) => [o.id, o.kind]), [["backups-kept", "choice"], ["memory", "choice"], ["extra-disk-10-gb", "quantity"]]);
  assert.deepEqual(options[1].kind === "choice" && options[1].choices[2], { id: "4-gb", name: "4 GB", monthly: 1000, memoryMb: 3072, diskGb: 5 });
  assert.deepEqual(options[2].kind === "quantity" && [options[2].unit, options[2].min, options[2].max], [{ monthly: 200, memoryMb: undefined, diskGb: 10 }, 0, 20]);
  assert.deepEqual(parseOptionLines(formatOptionLines(options)), options);
  for (const bad of ["select | X | a = 1 ; b = 2", "choice | Only one | a = 1", "choice | X | a = free ; b = 2", "quantity | X | 2.00 | 5 | 1", "choice | Dup | a = 0 ; A = 1", "quantity | | 1"]) assert.throws(() => parseOptionLines(bad), /not understood/, bad);
  assert.throws(() => parseOptionLines("choice | Same | a = 0 ; b = 1\nquantity | Same | 1"), /own name/);
});

test("picks become add-on lines: free defaults add nothing, quantities multiply, anything off the list is refused", () => {
  const options = parseOptionLines(LINES);
  assert.deepEqual(resolveOptions(options, {}), []);
  assert.deepEqual(resolveOptions(options, { "backups-kept": "30-days", memory: "4-gb", "extra-disk-10-gb": "3" }), [
    { id: "opt:backups-kept:30-days", name: "Backups kept: 30 days", monthly: 300, memoryMb: undefined, diskGb: undefined },
    { id: "opt:memory:4-gb", name: "Memory: 4 GB", monthly: 1000, memoryMb: 3072, diskGb: 5 },
    { id: "opt:extra-disk-10-gb:3", name: "Extra disk (10 GB) × 3", monthly: 600, memoryMb: undefined, diskGb: 30 },
  ]);
  assert.throws(() => resolveOptions(options, { memory: "64-gb" }), /Memory: this choice is not available/);
  for (const qty of ["21", "-1", "1.5", "lots"]) assert.throws(() => resolveOptions(options, { "extra-disk-10-gb": qty }), /between 0 and 20/, qty);
});

test("an order with options: priced per cycle, on the invoice line, kept on the service for renewals and resources", async () => {
  const dbm = await import("../src/db");
  const billing = await import("../src/lib/billing");
  const db = await dbm.getDb();
  const [user] = await db.insert(dbm.schema.users).values({ email: "opt@example.test", passwordHash: "x" }).returning();
  const [group] = await db.insert(dbm.schema.productGroups).values({ name: "Hosting", slug: "hosting" }).returning();
  const [product] = await db.insert(dbm.schema.products).values({ groupId: group.id, name: "Start", slug: "start", module: "manual", requiresDomain: false, pricing: { monthly: 1000, annually: 10_000 }, options: parseOptionLines(LINES) }).returning();

  const { invoiceId, serviceId } = await billing.placeOrder({ clientId: user.id, productId: product.id, cycle: "annually", domain: "", options: { memory: "2-gb", "extra-disk-10-gb": "2" } });
  const [invoice] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.equal(invoice.subtotal, 10_000 + (400 + 400) * 12);
  const [item] = await db.select().from(dbm.schema.invoiceItems).where(eq(dbm.schema.invoiceItems.invoiceId, invoiceId));
  assert.match(item.description, /Start \+ Memory: 2 GB, Extra disk \(10 GB\) × 2/);
  const [service] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, serviceId));
  assert.equal(service.amount, invoice.subtotal, "renewals cost the same");
  assert.deepEqual((service.moduleData.addons as { memoryMb?: number; diskGb?: number }[]).map((a) => [a.memoryMb, a.diskGb]), [[1024, undefined], [undefined, 20]]);

  await assert.rejects(billing.placeOrder({ clientId: user.id, productId: product.id, cycle: "monthly", domain: "", options: { memory: "1-tb" } }), /not available/);
});
