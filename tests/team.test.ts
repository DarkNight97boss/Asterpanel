import assert from "node:assert/strict";
import { before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import type { Transporter } from "nodemailer";

process.env.PGLITE_DIR = "memory://";
process.env.APP_SECRET = "test-secret";
process.env.APP_URL = "https://panel.example.test";

const outbox: { to: string; text: string }[] = [];
let dbm: typeof import("../src/db");
let team: typeof import("../src/lib/team");
let account: typeof import("../src/lib/roles");
type User = import("../src/lib/auth").SessionUser;
let owner: User, dev: User, stranger: User;
let co: string;

before(async () => {
  dbm = await import("../src/db");
  team = await import("../src/lib/team");
  account = await import("../src/lib/roles");
  const { setTransportForTests } = await import("../src/lib/mail/transport");
  setTransportForTests({ sendMail: async (m: { to: string; text: string }) => void outbox.push(m) } as unknown as Transporter);
  const db = await dbm.getDb();
  const mk = async (email: string, company = "") => (await db.insert(dbm.schema.users).values({ email, passwordHash: "x", firstName: email.split("@")[0], company }).returning())[0] as unknown as User;
  owner = await mk("owner@example.test", "Rossi Web Agency");
  dev = await mk("dev@example.test");
  stranger = await mk("stranger@example.test");
  // The first visit gives a user their own company, named after their profile.
  const [first] = await account.listAccounts(owner);
  assert.deepEqual([first.name, first.role, first.ownerUserId], ["Rossi Web Agency", "owner", owner.id]);
  co = first.id;
});

test("an invite is bound to its email address and can be used once", async () => {
  await assert.rejects(team.inviteMember(co, owner, owner.email, "admin"), /already has full access/);
  const { sent, path } = await team.inviteMember(co, owner, dev.email, "billing");
  assert.equal(sent.ok, true);
  assert.match(outbox[0].text, /Rossi Web Agency/);
  const token = decodeURIComponent(path.split("token=")[1]);
  assert.ok(outbox[0].text.includes(`https://panel.example.test${path}`));

  await assert.rejects(team.acceptInvite(token, stranger), /different email address/);
  assert.equal(await team.acceptInvite(token, dev), co);
  await assert.rejects(team.acceptInvite(token, dev), /invalid or has expired/);
  await assert.rejects(team.inviteMember(co, owner, dev.email, "admin"), /already a member/);
});

test("re-inviting before acceptance refreshes the link; old links die", async () => {
  const first = await team.inviteMember(co, owner, "later@example.test", "developer");
  const second = await team.inviteMember(co, owner, "later@example.test", "admin");
  const tok = (p: string) => decodeURIComponent(p.split("token=")[1]);
  assert.equal(await team.findInvite(tok(first.path)), null);
  assert.equal((await team.findInvite(tok(second.path)))?.invite.role, "admin");

  const db = await dbm.getDb();
  await db.update(dbm.schema.companyMembers).set({ invitedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(dbm.schema.companyMembers.email, "later@example.test"));
  assert.equal(await team.findInvite(tok(second.path)), null, "expired after 7 days");
});

test("roles map to permissions; a user can belong to several companies", async () => {
  // Invited people do not get a company of their own until they create one.
  assert.deepEqual((await account.listAccounts(dev)).map((a) => [a.name, a.role, a.ownerUserId]), [["Rossi Web Agency", "billing", owner.id]]);
  const mine = await account.createCompany(dev, "  Dev Studio  ");
  const accounts = await account.listAccounts({ ...dev } as User);
  assert.deepEqual(accounts.map((a) => [a.name, a.role]), [["Rossi Web Agency", "billing"], ["Dev Studio", "owner"]]);
  assert.equal(accounts[1].id, mine);
  assert.deepEqual((await account.listAccounts(stranger)).map((a) => [a.name, a.role]), [["stranger", "owner"]]);

  const can = account.roleCan;
  assert.deepEqual([can("billing", "billing"), can("billing", "hosting"), can("billing", "manage")], [true, false, false]);
  assert.deepEqual([can("developer", "hosting"), can("developer", "billing"), can("developer", "manage")], [true, false, false]);
  assert.deepEqual([can("admin", "manage"), can("owner", "manage")], [true, true]);
});

test("a developer can be limited to specific services; staging follows its live site", async () => {
  const roles = await import("../src/lib/roles");
  const db = await dbm.getDb();
  await db.update(dbm.schema.companyMembers).set({ role: "developer", workloadIds: ["site-a"] }).where(and(eq(dbm.schema.companyMembers.userId, dev.id), eq(dbm.schema.companyMembers.companyId, co)));
  const [asMember] = await roles.listAccounts({ ...dev, id: dev.id } as User);
  assert.deepEqual(asMember.only, ["site-a"]);
  assert.equal(roles.mayAccess(asMember, { id: "site-a" }), true);
  assert.equal(roles.mayAccess(asMember, { id: "stg", parentId: "site-a" }), true);
  assert.equal(roles.mayAccess(asMember, { id: "site-b" }), false);
  assert.equal(roles.mayAccess({ only: null }, { id: "anything" }), true);

  await db.update(dbm.schema.companyMembers).set({ role: "billing" }).where(and(eq(dbm.schema.companyMembers.userId, dev.id), eq(dbm.schema.companyMembers.companyId, co)));
  // listAccounts is request-cached by user object: a fresh object reads fresh data.
  const [asBilling] = await roles.listAccounts({ ...dev } as User);
  assert.equal(asBilling.only, null, "the restriction only applies to developers");
});
