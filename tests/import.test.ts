import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let imp: typeof import("../src/lib/import");
let whmcs: typeof import("../src/lib/whmcs");

const bundle = () => ({
  source: "WHMCS",
  clients: [
    { ref: "1", email: "Mario@Rossi.test", firstName: "Mario", lastName: "Rossi", company: "Rossi Srl", vatId: "IT01234567890", country: "it", city: "Roma" },
    { ref: "2", email: "already@here.test", firstName: "Already" },
    { ref: "3", email: "not-an-email" },
    { ref: "4", email: "closed@old.test", active: false },
  ],
  services: [
    { ref: "10", clientRef: "1", product: "Hosting Pro", domain: "Rossi.test", cycle: "Annually", amount: 12000, nextDueDate: "2027-03-01", createdAt: "2021-03-01", status: "Active" },
    { ref: "11", clientRef: "1", product: "hosting pro", cycle: "Monthly", amount: 1500, nextDueDate: "0000-00-00", status: "Suspended" },
    { ref: "12", clientRef: "1", product: "Old plan", cycle: "Monthly", amount: 500, status: "Cancelled" },
    { ref: "13", clientRef: "3", product: "Hosting Pro", cycle: "Monthly", amount: 500, status: "Active" },
    { ref: "14", clientRef: "2", product: "Catalogue plan", cycle: "Triennially", amount: 500, status: "Active" },
    { ref: "15", clientRef: "2", product: "Catalogue plan", cycle: "Quarterly", amount: 3000, nextDueDate: "2026-12-01", status: "Active" },
  ],
  domains: [
    { ref: "20", clientRef: "1", name: "ROSSI.test", registrar: "internetbs", amount: 1290, expiresAt: "2027-05-05", nextDueDate: "2027-05-05", status: "Active" },
    { ref: "21", clientRef: "1", name: "rossi-shop.test", registrar: "enom", amount: 1500, expiresAt: "2027-01-01", status: "Active" },
    { ref: "22", clientRef: "1", name: "gone.test", registrar: "enom", amount: 1500, status: "Cancelled" },
    { ref: "23", clientRef: "1", name: "not a domain", amount: 1, status: "Active" },
  ],
});

before(async () => {
  dbm = await import("../src/db");
  imp = await import("../src/lib/import");
  whmcs = await import("../src/lib/whmcs");
  const db = await dbm.getDb();
  await db.insert(dbm.schema.users).values({ email: "already@here.test", passwordHash: "kept" });
  const [g] = await db.insert(dbm.schema.productGroups).values({ slug: "h", name: "H" }).returning();
  await db.insert(dbm.schema.products).values({ groupId: g.id, name: "Catalogue plan", slug: "catalogue", module: "manual", pricing: { quarterly: 3000 } });
});

const counts = async () => {
  const db = await dbm.getDb();
  return { users: (await db.select().from(dbm.schema.users)).length, services: (await db.select().from(dbm.schema.services)).length, domains: (await db.select().from(dbm.schema.domainNames)).length, invoices: (await db.select().from(dbm.schema.invoices)).length, emails: (await db.select().from(dbm.schema.emailLog)).length };
};

test("preview writes nothing and says exactly what the import would do", async () => {
  const before = await counts();
  const report = await imp.runImport(bundle(), false);
  assert.deepEqual(await counts(), before);
  assert.deepEqual([report.clients, report.services, report.domains], [{ created: 2, existing: 1 }, { created: 3, existing: 0 }, { created: 2, existing: 0 }]);
  assert.deepEqual(report.products, ["Hosting Pro"]);
  assert.deepEqual(report.skipped, ["customer 3: no valid email", "service 13: its customer was not imported", "service 14: billing cycle “Triennially” is not supported", "domain 23: “not a domain” is not a domain name"]);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /service 11: no next due date/);
  assert.match(report.warnings[1], /rossi-shop\.test: registrar “enom” is not connected/);
});

test("the import: customers with a company and no usable password, services that renew from their due date, nothing charged or emailed", async () => {
  const db = await dbm.getDb();
  const report = await imp.runImport(bundle(), true);
  assert.deepEqual(report.clients, { created: 2, existing: 1 });
  const [mario] = await db.select().from(dbm.schema.users).where(eq(dbm.schema.users.email, "mario@rossi.test"));
  assert.deepEqual([mario.firstName, mario.country, mario.status], ["Mario", "IT", "active"]);
  assert.match(mario.passwordHash, /^\$|^scrypt|:/, "a real hash of a secret nobody knows");
  const [closed] = await db.select().from(dbm.schema.users).where(eq(dbm.schema.users.email, "closed@old.test"));
  assert.equal(closed.status, "suspended");
  const [kept] = await db.select().from(dbm.schema.users).where(eq(dbm.schema.users.email, "already@here.test"));
  assert.equal(kept.passwordHash, "kept", "existing accounts are not touched");

  const [company] = await db.select().from(dbm.schema.companies).where(eq(dbm.schema.companies.vatId, "IT01234567890"));
  assert.deepEqual([company.name, company.orgType], ["Rossi Srl", "company"]);
  const services = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.companyId, company.id));
  const hosting = services.find((s) => s.domain === "rossi.test" && s.billingCycle === "annually")!;
  assert.deepEqual([hosting.status, hosting.amount, hosting.nextDueDate?.toISOString().slice(0, 10), hosting.createdAt.toISOString().slice(0, 10)], ["active", 12000, "2027-03-01", "2021-03-01"]);
  assert.equal(services.find((s) => s.amount === 1500 && s.billingCycle === "monthly")!.status, "suspended");
  // Both "Hosting Pro" and "hosting pro" are one product: hidden and manual, so nothing is provisioned by surprise.
  const created = (await db.select().from(dbm.schema.products)).filter((p) => p.name === "Hosting Pro");
  assert.deepEqual(created.map((p) => [p.module, p.hidden]), [["manual", true]]);

  const domains = await db.select().from(dbm.schema.domainNames);
  assert.deepEqual(domains.map((d) => [d.name, d.registrar, d.status]).sort(), [["rossi-shop.test", "enom", "active"], ["rossi.test", "internetbs", "active"]]);
  const c = await counts();
  assert.deepEqual([c.invoices, c.emails], [0, 0]);
});

test("running it again adds nothing; the renewal run then bills an imported service when it comes due", async () => {
  const before = await counts();
  const again = await imp.runImport(bundle(), true);
  assert.deepEqual([again.clients, again.services, again.domains], [{ created: 0, existing: 3 }, { created: 0, existing: 3 }, { created: 0, existing: 2 }]);
  assert.deepEqual(await counts(), before);

  const billing = await import("../src/lib/billing");
  const run = await billing.runAutomation(new Date("2026-11-25T00:00:00Z"));
  assert.equal(run.invoiced, 1, "the quarterly service due on 2026-12-01");
});

test("WHMCS reader: API credentials, paging, details per customer, money in cents; errors are WHMCS's words", async () => {
  const calls: Record<string, string>[] = [];
  whmcs.setWhmcsHttpForTests((async (url: string, init: RequestInit) => {
    const p = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ url, ...p });
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (p.secret !== "s3cret") return json({ result: "error", message: "Invalid or missing credentials" });
    if (p.action === "GetClients") {
      const start = Number(p.limitstart ?? 0);
      const total = 251;
      const n = Math.min(Number(p.limitnum), total - start);
      return json({ result: "success", totalresults: total, clients: { client: Array.from({ length: n }, (_, i) => ({ id: start + i + 1, firstname: "A", lastname: "B", companyname: "", email: `c${start + i + 1}@x.test`, status: "Active" })) } });
    }
    if (p.action === "GetClientsDetails") return json({ result: "success", client: { address1: "Via Roma 1", address2: "int. 2", city: "Milano", postcode: "20100", countrycode: "IT", phonenumber: "+39.021234", tax_id: "IT999" } });
    if (p.action === "GetClientsProducts") return json({ result: "success", totalresults: 1, products: { product: [{ id: 7, clientid: 1, name: "Hosting", domain: "x.test", billingcycle: "Monthly", recurringamount: "9.99", nextduedate: "2026-10-01", regdate: "2020-01-01", status: "Active" }] } });
    if (p.action === "GetClientsDomains") return json({ result: "success", totalresults: 0, domains: "" });
    return json({ result: "error", message: "unknown action" });
  }) as typeof fetch);

  const access = { url: "https://billing.example.com/whmcs/", identifier: "id1", secret: "s3cret" };
  const b = await whmcs.fetchWhmcsBundle(access);
  assert.equal(calls[0].url, "https://billing.example.com/whmcs/includes/api.php");
  assert.deepEqual([calls[0].identifier, calls[0].responsetype], ["id1", "json"]);
  assert.equal(b.clients.length, 251);
  assert.deepEqual([b.clients[0].address, b.clients[0].vatId, b.clients[0].country], ["Via Roma 1, int. 2", "IT999", "IT"]);
  assert.deepEqual(b.services, [{ ref: "7", clientRef: "1", product: "Hosting", domain: "x.test", cycle: "Monthly", amount: 999, nextDueDate: "2026-10-01", createdAt: "2020-01-01", status: "Active" }]);
  assert.deepEqual(b.domains, []);
  assert.ok(calls.every((c) => /^Get/.test(c.action)), "read-only");

  await assert.rejects(whmcs.testWhmcs({ ...access, secret: "wrong" }), /Invalid or missing credentials/);
  await assert.rejects(whmcs.testWhmcs({ ...access, url: "http://billing.example.com" }), /https/);
  await assert.rejects(whmcs.testWhmcs({ ...access, url: "https://192.168.1.10" }), /https/);
});
