import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";

let dbm: typeof import("../src/db");
let domains: typeof import("../src/lib/domains");
let billing: typeof import("../src/lib/billing");
let clientId: string;

/** A pretend registrar: records every call and answers in each API's own format. */
const calls: { url: string; params: Record<string, string> }[] = [];
const registered = new Set<string>(["taken.com"]);
let failRegister = false;
const fakeHttp = (async (url: string | URL | Request, init?: RequestInit) => {
  const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
  calls.push({ url: String(url), params });
  const u = String(url);
  if (u.includes("rrpproxy")) {
    const ok = (props = "") => new Response(`[RESPONSE]\ncode = 200\ndescription = Command completed successfully\n${props}EOF\n`);
    switch (params.command) {
      case "CheckDomains":
        return ok(Object.entries(params).filter(([k]) => k.startsWith("domain")).map(([, d], i) => `property[domaincheck][${i}] = ${registered.has(d) ? "211 Domain name not available" : "210 Available"}\n`).join(""));
      case "AddContact":
        return ok("property[contact][0] = P-ABC123\n");
      case "AddDomain":
        if (failRegister) return new Response("[RESPONSE]\ncode = 549\ndescription = Insufficient funds\nEOF\n");
        registered.add(params.domain);
        return ok();
      case "StatusDomain":
        return ok("property[registration expiration date][0] = 2027-09-19 10:00:00\nproperty[nameserver][0] = NS1.ASTER.TEST\nproperty[nameserver][1] = ns2.aster.test\nproperty[transferlock][0] = 1\nproperty[status][0] = ACTIVE\nproperty[auth][0] = EPP-SECRET\n");
      default:
        return ok();
    }
  }
  const json = (o: unknown) => new Response(JSON.stringify(o));
  if (u.endsWith("/Domain/Check")) return json({ status: registered.has(params.Domain) ? "UNAVAILABLE" : "AVAILABLE" });
  if (u.endsWith("/Domain/Info")) return json({ status: "SUCCESS", domainstatus: "REGISTERED", expirationdate: "2027/09/19", registrarlock: "ENABLED", nameserver: ["ns1.aster.test", "ns2.aster.test"], transferauthinfo: "IBS-CODE" });
  if (u.endsWith("/Account/Balance/Get")) return json({ status: "SUCCESS", balance: [{ amount: "12.50", currency: "USD" }] });
  if (u.endsWith("/Domain/Transfer/Initiate")) return json({ status: "PENDING" });
  return json({ status: "SUCCESS" });
}) as typeof fetch;

const contact = { firstName: "Mario", lastName: "Rossi", organization: "", email: "Mario@Example.test", phone: "+39 06 1234567", address: "Via Roma 1", city: "Roma", zip: "00100", state: "RM", country: "it", taxCode: "rssmra80a01h501u" };

before(async () => {
  dbm = await import("../src/db");
  domains = await import("../src/lib/domains");
  billing = await import("../src/lib/billing");
  const { updateSettings } = await import("../src/lib/settings");
  domains.setRegistrarHttpForTests(fakeHttp);
  const db = await dbm.getDb();
  [{ id: clientId }] = await db.insert(dbm.schema.users).values({ email: "d@example.test", passwordHash: "x", firstName: "Mario" }).returning();
  await updateSettings("registrars", { accounts: { centralnic: { login: "reseller", password: "pw", sandbox: "1" }, internetbs: { apiKey: "key", password: "pw", sandbox: "1" } }, nameservers: ["ns1.aster.test", "ns2.aster.test"] });
  await db.insert(dbm.schema.domainTlds).values([
    { tld: "com", registrar: "centralnic", registerPrice: 1290, renewPrice: 1490, transferPrice: 1190, sort: 1 },
    { tld: "it", registrar: "internetbs", registerPrice: 990, renewPrice: 1190, transferPrice: 990, sort: 2 },
    { tld: "co.uk", registrar: "internetbs", registerPrice: 890, renewPrice: 890, transferPrice: 0, sort: 3 },
    { tld: "dev", registrar: "centralnic", registerPrice: 1900, renewPrice: 1900, transferPrice: 1900, enabled: false },
  ]);
});

test("names, phones, name servers and contacts are normalised or refused", () => {
  const tlds = ["uk", "co.uk", "com"];
  assert.deepEqual(domains.splitDomain("https://WWW.Example.co.uk/path", tlds), { name: "example.co.uk", sld: "example", tld: "co.uk" });
  for (const bad of ["sub.example.com", "-bad.com", "bad-.com", "a.com", "exa mple.com", "example.org", "exämple.com", "a;b.com"]) assert.equal(domains.splitDomain(bad, tlds), null, bad);
  assert.equal(domains.normalizePhone("+39 06 1234567"), "+39.061234567");
  assert.equal(domains.normalizePhone("0044 (20) 7946-0000"), "+44.2079460000");
  assert.equal(domains.normalizePhone("+1 212 555 0100"), "+1.2125550100");
  assert.equal(domains.normalizePhone("+351912345678"), "+351.912345678");
  for (const bad of ["06 1234567", "+999 123456789", "+39", "call me"]) assert.throws(() => domains.normalizePhone(bad), domains.DomainError, bad);
  assert.deepEqual(domains.cleanNameservers(["NS1.Example.com.", "ns2.example.com", "ns1.example.com"]), ["ns1.example.com", "ns2.example.com"]);
  for (const bad of [["ns1.example.com"], ["ns1.example.com", "not a host"], ["ns1.example.com", "10.0.0.1"]]) assert.throws(() => domains.cleanNameservers(bad), domains.DomainError);
  const c = domains.cleanContact(contact, "example.it");
  assert.deepEqual([c.email, c.country, c.taxCode, c.phone], ["mario@example.test", "IT", "RSSMRA80A01H501U", "+39.061234567"]);
  assert.throws(() => domains.cleanContact({ ...contact, taxCode: "" }, "example.it"), /\.it registry/);
  assert.throws(() => domains.cleanContact({ ...contact, firstName: "Ma\nrio" }), domains.DomainError);
});

test("search asks each TLD's registrar once and only offers the TLDs on sale", async () => {
  calls.length = 0;
  const hits = await domains.searchDomains("Taken.com");
  assert.deepEqual(hits.map((h) => [h.domain, h.available, h.registerPrice]), [["taken.com", false, 1290], ["taken.it", true, 990], ["taken.co.uk", true, 890]]);
  assert.equal(calls.filter((c) => c.params.command === "CheckDomains").length, 1, "CentralNic checks in one batch");
  assert.ok(calls.every((c) => /api-ote\.rrpproxy\.net|testapi\.internetbs\.net/.test(c.url)), "sandbox endpoints when sandbox is on");
  await assert.rejects(domains.searchDomains("no_good"), domains.DomainError);
});

test("register: invoiced at the register price, registered on payment, renewed yearly at the renew price", async () => {
  const db = await dbm.getDb();
  await assert.rejects(domains.orderDomain({ clientId, companyId: null, domain: "taken.com", action: "register", contact }), /no longer available/);
  await assert.rejects(domains.orderDomain({ clientId, companyId: null, domain: "example.dev", action: "register", contact }), /not on sale/);

  calls.length = 0;
  const { invoiceId, domainId } = await domains.orderDomain({ clientId, companyId: null, domain: "Aster-Demo.com", action: "register", contact });
  const [invoice] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.equal(invoice.subtotal, 1290);
  assert.ok(!calls.some((c) => c.params.command === "AddDomain"), "nothing is registered before payment");
  await assert.rejects(domains.orderDomain({ clientId, companyId: null, domain: "aster-demo.com", action: "register", contact }), /already in an account/);

  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "t1", amount: invoice.total });
  const add = calls.find((c) => c.params.command === "AddDomain")!;
  assert.deepEqual([add.params.domain, add.params.period, add.params.ownercontact0, add.params.nameserver0, add.params.nameserver1], ["aster-demo.com", "1", "P-ABC123", "ns1.aster.test", "ns2.aster.test"]);
  let [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  assert.deepEqual([d.status, d.expiresAt?.toISOString(), d.locked, d.nameservers], ["active", "2027-09-19T10:00:00.000Z", true, ["ns1.aster.test", "ns2.aster.test"]]);
  const [svc] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, d.serviceId!));
  assert.deepEqual([svc.status, svc.amount, svc.billingCycle], ["active", 1490, "annually"]);

  // Renewal: the billing run invoices it, paying renews at the registrar with the expiry-year guard.
  await billing.runAutomation(new Date(svc.nextDueDate!.getTime() - 86_400_000));
  const renewal = (await db.select().from(dbm.schema.invoices)).find((i) => i.id !== invoiceId && i.status === "unpaid")!;
  assert.equal(renewal.subtotal, 1490);
  await billing.recordPayment({ invoiceId: renewal.id, gateway: "bank", externalId: "t2", amount: renewal.total });
  const renew = calls.find((c) => c.params.command === "RenewDomain")!;
  assert.deepEqual([renew.params.domain, renew.params.period, renew.params.expiration], ["aster-demo.com", "1", "2027"]);

  // Management goes through the registrar and is refused when it makes no sense.
  await domains.setDomainNameservers(domainId, ["ns1.cloud.example", "ns2.cloud.example"]);
  assert.equal(calls.at(-1)!.params.nameserver1, "ns2.cloud.example");
  await assert.rejects(domains.domainAuthCode(domainId), /Unlock the domain first/);
  await domains.setDomainLock(domainId, false);
  assert.equal(await domains.domainAuthCode(domainId), "EPP-SECRET");
  [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  assert.equal(d.locked, false);
});

test("a registrar failure keeps the invoice paid, marks the domain failed, and a retry cannot register twice", async () => {
  const db = await dbm.getDb();
  const { invoiceId, domainId } = await domains.orderDomain({ clientId, companyId: null, domain: "unlucky.com", action: "register", contact });
  failRegister = true;
  const [invoice] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "t3", amount: invoice.total });
  let [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  assert.deepEqual([d.status, d.statusMessage], ["failed", "Insufficient funds (549)"]);
  assert.equal((await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId)))[0].status, "paid");

  failRegister = false;
  await billing.activateService(d.serviceId!); // staff retry
  calls.length = 0;
  await billing.activateService(d.serviceId!).catch(() => {});
  assert.ok(!calls.some((c) => c.params.command === "AddDomain"), "already active: no second registration");
  [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  assert.equal(d.status, "active");
});

test("transfer via Internet.bs: the auth code is encrypted at rest, sent once, then forgotten; .it carries the registry fields", async () => {
  const db = await dbm.getDb();
  await assert.rejects(domains.orderDomain({ clientId, companyId: null, domain: "moving.it", action: "transfer", contact }), /transfer \(EPP/);
  const { invoiceId, domainId } = await domains.orderDomain({ clientId, companyId: null, domain: "moving.it", action: "transfer", authCode: "AUTH-123", contact });
  let [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  let [svc] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, d.serviceId!));
  assert.ok(!JSON.stringify(svc.moduleData).includes("AUTH-123"));
  const [invoice] = await db.select().from(dbm.schema.invoices).where(eq(dbm.schema.invoices.id, invoiceId));
  assert.equal(invoice.subtotal, 990);

  calls.length = 0;
  await billing.recordPayment({ invoiceId, gateway: "bank", externalId: "t4", amount: invoice.total });
  const init = calls.find((c) => c.url.endsWith("/Domain/Transfer/Initiate"))!;
  assert.deepEqual([init.params.Domain, init.params.transferAuthInfo, init.params.Registrant_dotitRegCode, init.params.Registrant_dotitEntityType, init.params.Registrant_PhoneNumber, init.params.ApiKey], ["moving.it", "AUTH-123", "RSSMRA80A01H501U", "1", "+39.061234567", "key"]);
  [svc] = await db.select().from(dbm.schema.services).where(eq(dbm.schema.services.id, d.serviceId!));
  assert.deepEqual(svc.moduleData.request, { action: "transfer" });
  [d] = await db.select().from(dbm.schema.domainNames).where(eq(dbm.schema.domainNames.id, domainId));
  assert.equal(d.status, "active", "the sync saw the completed transfer");
  assert.equal(await domains.testRegistrar("internetbs"), "Balance: 12.50 USD");
});

test("CentralNic answers are parsed whatever the spacing and casing", async () => {
  const { parseCnr } = await import("../src/modules/registrars/centralnic");
  const r = parseCnr("[RESPONSE]\r\nCode=200\r\nDescription = OK = fine\r\nproperty[Registration Expiration Date][0]= 2027-01-01 00:00:00\r\nPROPERTY[nameserver][1] = b\r\nproperty[nameserver][0] = a\r\nEOF");
  assert.deepEqual(r, { code: 200, description: "OK = fine", props: { registrationexpirationdate: ["2027-01-01 00:00:00"], nameserver: ["a", "b"] } });
});
