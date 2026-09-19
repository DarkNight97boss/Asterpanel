import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Block } from "@/cms/blocks";

/**
 * Conventions
 * - Money is always stored as integer minor units (cents).
 * - Enumerations are plain text columns typed with `$type<>()` so adding a
 *   value never requires a migration.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ─── Identity ────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "staff" | "client";
/** What a `staff` user may open in the back office (see lib/staff.ts). */
export type StaffRole = "manager" | "ops" | "support" | "billing" | "content";
export type UserStatus = "active" | "suspended" | "closed";

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<UserRole>().notNull().default("client"),
    staffRole: text("staff_role").$type<StaffRole | "">().notNull().default(""),
    status: text("status").$type<UserStatus>().notNull().default("active"),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    company: text("company").notNull().default(""),
    vatId: text("vat_id").notNull().default(""),
    phone: text("phone").notNull().default(""),
    address: text("address").notNull().default(""),
    city: text("city").notNull().default(""),
    zip: text("zip").notNull().default(""),
    state: text("state").notNull().default(""),
    country: text("country").notNull().default(""),
    adminNotes: text("admin_notes").notNull().default(""),
    /** AES-256-GCM encrypted base32 TOTP secret; set while enrolling, trusted once `totpEnabledAt` is set. */
    totpSecret: text("totp_secret").notNull().default(""),
    totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
    /** Last accepted 30-second step: a code can never be used twice. */
    totpLastStep: integer("totp_last_step").notNull().default(0),
    /** SHA-256 hashes of unused one-time recovery codes. */
    recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the cookie token — the raw token never touches the database. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    /** Set when a staff member is acting as this user ("sign in as client"). */
    impersonatorId: uuid("impersonator_id"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const passwordResets = pgTable(
  "password_resets",
  {
    /** SHA-256 of the emailed token. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("password_resets_user_idx").on(t.userId)],
);

export type TeamRole = "admin" | "developer" | "billing";
export type CompanyRole = "owner" | TeamRole;

/**
 * The customer. Sites, plans, invoices, tickets and DNS zones belong to a
 * company, never to a person; people get in through `company_members`. A user
 * can belong to many companies and create new ones.
 */
export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  orgType: text("org_type").$type<"individual" | "company">().notNull().default("company"),
  /** Name printed on invoices when it differs from `name`. */
  billingName: text("billing_name").notNull().default(""),
  /** National company / tax code (e.g. codice fiscale). */
  taxCode: text("tax_code").notNull().default(""),
  vatId: text("vat_id").notNull().default(""),
  address1: text("address1").notNull().default(""),
  address2: text("address2").notNull().default(""),
  city: text("city").notNull().default(""),
  zip: text("zip").notNull().default(""),
  state: text("state").notNull().default(""),
  country: text("country").notNull().default(""),
  /** Italian e-invoicing: 7-character recipient code and/or certified email. */
  sdiCode: text("sdi_code").notNull().default(""),
  pec: text("pec").notNull().default(""),
  /** Customer object at Stripe that holds this company's saved cards. */
  stripeCustomerId: text("stripe_customer_id").notNull().default(""),
  /** Charge renewal invoices on the default saved card. */
  autoPay: boolean("auto_pay").notNull().default(true),
  /** Prepaid balance in cents, spent on new invoices before any card is charged. */
  creditBalance: integer("credit_balance").notNull().default(0),
  createdAt: createdAt(),
});

/** Membership or pending invitation. `userId` is set when the invite is accepted. */
export const companyMembers = pgTable(
  "company_members",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<CompanyRole>().notNull(),
    /** Restricts a developer to these services (and their staging). Null = every service. */
    workloadIds: jsonb("workload_ids").$type<string[] | null>(),
    /** SHA-256 of the emailed invite token; cleared once accepted. */
    inviteTokenHash: text("invite_token_hash").notNull().default(""),
    invitedAt: createdAt(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("company_member_email_idx").on(t.companyId, t.email), index("company_member_user_idx").on(t.userId)],
);

/** Legacy (pre-companies) memberships. Superseded by `company_members`; kept so old installs migrate without a destructive step. */
export const teamMembers = pgTable("team_members", {
  id: id(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  memberId: uuid("member_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").$type<TeamRole>().notNull(),
  workloadIds: jsonb("workload_ids").$type<string[] | null>(),
  inviteTokenHash: text("invite_token_hash").notNull().default(""),
  invitedAt: createdAt(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
}, (t) => [uniqueIndex("team_owner_email_idx").on(t.ownerId, t.email), index("team_member_idx").on(t.memberId)]);

// ─── Settings & CMS ──────────────────────────────────────────────────────────

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export type PageStatus = "draft" | "published";

export const pages = pgTable(
  "pages",
  {
    id: id(),
    /** Empty string is the home page. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<PageStatus>().notNull().default("draft"),
    blocks: jsonb("blocks").$type<Block[]>().notNull().default([]),
    seoTitle: text("seo_title").notNull().default(""),
    seoDescription: text("seo_description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pages_slug_idx").on(t.slug)],
);

export type MenuLocation = "header" | "footer";

export const menuItems = pgTable("menu_items", {
  id: id(),
  location: text("location").$type<MenuLocation>().notNull(),
  label: text("label").notNull(),
  href: text("href").notNull(),
  /** Footer column heading; empty = the bottom row of small links. */
  columnTitle: text("column_title").notNull().default(""),
  position: integer("position").notNull().default(0),
});

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const productGroups = pgTable(
  "product_groups",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull().default(0),
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [uniqueIndex("product_groups_slug_idx").on(t.slug)],
);

export const BILLING_CYCLES = [
  "monthly",
  "quarterly",
  "semiannually",
  "annually",
  "biennially",
  "onetime",
] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Price in cents per enabled cycle, plus an optional one-off setup fee. */
export type Pricing = Partial<Record<BillingCycle, number>> & { setup?: number };

export const products = pgTable(
  "products",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => productGroups.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull().default(""),
    description: text("description").notNull().default(""),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    pricing: jsonb("pricing").$type<Pricing>().notNull().default({}),
    requiresDomain: boolean("requires_domain").notNull().default(true),
    /** Provisioning module id, see src/modules/provisioning. */
    module: text("module").notNull().default("manual"),
    /** Module-specific product options (e.g. the WHM package name). */
    moduleConfig: jsonb("module_config").$type<Record<string, string>>().notNull().default({}),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    featured: boolean("featured").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("products_slug_idx").on(t.slug)],
);

export const servers = pgTable("servers", {
  id: id(),
  name: text("name").notNull(),
  module: text("module").notNull(),
  hostname: text("hostname").notNull().default(""),
  /** AES-256-GCM encrypted JSON of the module's connection fields. */
  credentials: text("credentials").notNull().default(""),
  maxAccounts: integer("max_accounts").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

// ─── Billing ─────────────────────────────────────────────────────────────────

export type OrderStatus = "pending" | "active" | "cancelled" | "fraud";

export const orders = pgTable(
  "orders",
  {
    id: id(),
    number: serial("number").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").$type<OrderStatus>().notNull().default("pending"),
    invoiceId: uuid("invoice_id"),
    total: integer("total").notNull().default(0),
    ip: text("ip").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("orders_client_idx").on(t.clientId)],
);

export type ServiceStatus = "pending" | "active" | "suspended" | "terminated" | "cancelled";

export const services = pgTable(
  "services",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null" }),
    status: text("status").$type<ServiceStatus>().notNull().default("pending"),
    domain: text("domain").notNull().default(""),
    username: text("username").notNull().default(""),
    billingCycle: text("billing_cycle").$type<BillingCycle>().notNull(),
    /** Recurring amount in cents, frozen at order time. */
    amount: integer("amount").notNull(),
    nextDueDate: timestamp("next_due_date", { withTimezone: true }),
    /** The `nextDueDate` a renewal invoice was already issued for (dedupes the cron). */
    renewalInvoicedFor: timestamp("renewal_invoiced_for", { withTimezone: true }),
    suspendReason: text("suspend_reason").notNull().default(""),
    /** Opaque state owned by the provisioning module. */
    moduleData: jsonb("module_data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_client_idx").on(t.clientId), index("services_due_idx").on(t.nextDueDate)],
);

export type InvoiceStatus = "draft" | "unpaid" | "paid" | "cancelled" | "refunded";

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    /** Gapless within `fiscalYear`: taken from `counters` inside the inserting transaction. */
    number: serial("number").notNull(),
    /** 0 = issued before yearly numbering existed. */
    fiscalYear: integer("fiscal_year").notNull().default(0),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").$type<InvoiceStatus>().notNull().default("unpaid"),
    /** A credit note reverses `creditsInvoiceId` in full; it shares the numbering series. */
    kind: text("kind").$type<"invoice" | "credit_note">().notNull().default("invoice"),
    creditsInvoiceId: uuid("credits_invoice_id"),
    currency: text("currency").notNull(),
    subtotal: integer("subtotal").notNull().default(0),
    /** Basis points, e.g. 2200 = 22%. */
    taxRate: integer("tax_rate").notNull().default(0),
    tax: integer("tax").notNull().default(0),
    total: integer("total").notNull().default(0),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** How many overdue reminders were already emailed (dedupes the cron). */
    remindersSent: integer("reminders_sent").notNull().default(0),
    /** Automatic charges tried on a saved card, and when the last one was. */
    chargeAttempts: integer("charge_attempts").notNull().default(0),
    lastChargeAt: timestamp("last_charge_at", { withTimezone: true }),
    lastChargeError: text("last_charge_error").notNull().default(""),
    /** Electronic invoice: which intermediary has it, under what id, and what the SDI answered. */
    sdiProvider: text("sdi_provider").notNull().default(""),
    sdiId: text("sdi_id").notNull().default(""),
    sdiStatus: text("sdi_status").$type<"" | "sent" | "delivered" | "not_delivered" | "rejected" | "error">().notNull().default(""),
    sdiMessage: text("sdi_message").notNull().default(""),
    sdiSentAt: timestamp("sdi_sent_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("invoices_client_idx").on(t.clientId), index("invoices_status_idx").on(t.status), uniqueIndex("invoices_year_number_idx").on(t.fiscalYear, t.number)],
);

export type InvoiceItemKind = "new" | "renewal" | "setup" | "custom" | "discount" | "upgrade";

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    kind: text("kind").$type<InvoiceItemKind>().notNull().default("custom"),
    description: text("description").notNull(),
    amount: integer("amount").notNull(),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId)],
);

export const transactions = pgTable(
  "transactions",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    gateway: text("gateway").notNull(),
    /** Gateway-side reference; unique per gateway so webhooks are idempotent. */
    externalId: text("external_id").notNull().default(""),
    amount: integer("amount").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("transactions_invoice_idx").on(t.invoiceId)],
);

// ─── Platform: nodes, workloads, jobs ─────────────────────────────────────────

export type NodeStatus = "pending" | "online" | "offline" | "disabled";
export type NodeStats = { cpuPercent?: number; memTotalMb?: number; memUsedMb?: number; diskTotalGb?: number; diskUsedGb?: number; workloads?: number };

/** A server running the Aster agent. */
export const nodes = pgTable("nodes", {
  id: id(),
  name: text("name").notNull(),
  region: text("region").notNull().default(""),
  /** Wildcard domain pointing at this node: workloads get `<slug>.<baseDomain>`. */
  baseDomain: text("base_domain").notNull().default(""),
  publicIp: text("public_ip").notNull().default(""),
  /** SHA-256 of the agent's bearer token. */
  tokenHash: text("token_hash").notNull(),
  status: text("status").$type<NodeStatus>().notNull().default("pending"),
  driver: text("driver").notNull().default(""),
  agentVersion: text("agent_version").notNull().default(""),
  stats: jsonb("stats").$type<NodeStats>().notNull().default({}),
  maxWorkloads: integer("max_workloads").notNull().default(0),
  /** Cloud provider that runs this node; empty for physical / self-installed servers. */
  provider: text("provider").notNull().default(""),
  providerServerId: text("provider_server_id").notNull().default(""),
  providerRegion: text("provider_region").notNull().default(""),
  providerSize: text("provider_size").notNull().default(""),
  /** Created by the panel on its own when capacity ran out. */
  autoscaled: boolean("autoscaled").notNull().default(false),
  /** Since when the node has had no workloads; drives automatic removal. */
  emptySince: timestamp("empty_since", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const WORKLOAD_TYPES = ["wordpress", "app", "database", "static"] as const;
export type WorkloadType = (typeof WORKLOAD_TYPES)[number];
export type WorkloadStatus = "creating" | "running" | "stopped" | "suspended" | "error" | "deleting" | "deleted";

/** Type-specific, non-secret settings. */
export type WorkloadConfig = {
  // wordpress
  phpVersion?: string;
  adminEmail?: string;
  adminUser?: string;
  // database
  engine?: "mysql" | "postgres" | "redis";
  version?: string;
  // app & static
  repoUrl?: string;
  branch?: string;
  buildCommand?: string;
  outputDir?: string;
  port?: number;
  // wordpress: automatic updates
  autoUpdate?: "off" | "minor" | "all";
  autoUpdateLastAt?: string;
  /** Commands run inside the app's container on a schedule (UTC). */
  crons?: { schedule: string; command: string }[];
  /** Build a preview environment for every other branch that is pushed. */
  previews?: boolean;
  // edge rules (web workloads)
  redirects?: { from: string; to: string; code: 301 | 302 }[];
  denyIps?: string[];
  // bot protection (web workloads)
  botsBlockBad?: boolean;
  botsBlockAi?: boolean;
  botsRatePerMinute?: number;
  botsProtectLogin?: boolean;
  // static asset acceleration (WordPress)
  cdnEnabled?: boolean;
  cdnMaxAgeDays?: number;
  // edge page cache (WordPress)
  cacheEnabled?: boolean;
  cacheTtlMinutes?: number;
  cacheBypass?: string[];
  // file access (WordPress)
  sftpEnabled?: boolean;
  sftpPort?: number;
  /** OpenSSH public keys allowed to log in, besides the password. */
  sftpKeys?: { name: string; key: string }[];
  // plan limits
  memoryMb?: number;
  cpus?: number;
  diskGb?: number;
};

/** What the agent reports back about the running workload. */
export type WorkloadRuntime = {
  internalHost?: string;
  dbName?: string;
  dbUser?: string;
  diskUsedMb?: number;
  version?: string;
};

export const workloads = pgTable(
  "workloads",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    /** Staging environments point at their live workload. */
    parentId: uuid("parent_id"),
    type: text("type").$type<WorkloadType>().notNull(),
    /** `preview`: a short-lived copy of an app built from another branch. */
    environment: text("environment").$type<"live" | "staging" | "preview">().notNull().default("live"),
    name: text("name").notNull(),
    /** DNS-safe unique id: container names and the default hostname derive from it. */
    slug: text("slug").notNull(),
    status: text("status").$type<WorkloadStatus>().notNull().default("creating"),
    statusMessage: text("status_message").notNull().default(""),
    config: jsonb("config").$type<WorkloadConfig>().notNull().default({}),
    /** AES-256-GCM JSON: generated passwords, env vars, deploy tokens. */
    secrets: text("secrets").notNull().default(""),
    runtime: jsonb("runtime").$type<WorkloadRuntime>().notNull().default({}),
    /** Secret in the push-to-deploy webhook URL. */
    deployHookToken: text("deploy_hook_token").notNull().default(""),
    /** Free-form tags to group services ("client-acme", "to-migrate"). */
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** GitHub App installation that grants access to `githubRepo` ("owner/name"). */
    githubInstallationId: text("github_installation_id").notNull().default(""),
    githubRepo: text("github_repo").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workloads_slug_idx").on(t.slug), index("workloads_client_idx").on(t.clientId), index("workloads_node_idx").on(t.nodeId)],
);

export const domains = pgTable(
  "domains",
  {
    id: id(),
    workloadId: uuid("workload_id")
      .notNull()
      .references(() => workloads.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Generated `<slug>.<node base domain>` hostname: cannot be removed. */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("domains_hostname_idx").on(t.hostname), index("domains_workload_idx").on(t.workloadId)],
);

export type BackupStatus = "creating" | "ready" | "failed" | "restoring";

export const backups = pgTable(
  "backups",
  {
    id: id(),
    workloadId: uuid("workload_id")
      .notNull()
      .references(() => workloads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"manual" | "scheduled" | "system">().notNull().default("manual"),
    status: text("status").$type<BackupStatus>().notNull().default("creating"),
    note: text("note").notNull().default(""),
    sizeBytes: integer("size_bytes").notNull().default(0),
    /** Copy in object storage: `pending` while the job runs, then `uploaded` or `failed`. */
    offsite: text("offsite").$type<"none" | "pending" | "uploaded" | "failed">().notNull().default("none"),
    offsiteError: text("offsite_error").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("backups_workload_idx").on(t.workloadId)],
);

export type DeploymentStatus = "queued" | "building" | "live" | "failed";

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    workloadId: uuid("workload_id")
      .notNull()
      .references(() => workloads.id, { onDelete: "cascade" }),
    status: text("status").$type<DeploymentStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<"manual" | "push" | "create" | "rollback">().notNull().default("manual"),
    /** For a rollback: the deployment whose image was put back. */
    rollbackOf: uuid("rollback_of"),
    commitSha: text("commit_sha").notNull().default(""),
    commitMessage: text("commit_message").notNull().default(""),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("deployments_workload_idx").on(t.workloadId)],
);

// ─── DNS ─────────────────────────────────────────────────────────────────────

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export const dnsZones = pgTable(
  "dns_zones",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Apex domain, lowercase, no trailing dot. */
    name: text("name").notNull(),
    /** SOA serial, bumped on every change. */
    serial: integer("serial").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dns_zones_name_idx").on(t.name), index("dns_zones_client_idx").on(t.clientId)],
);

export const dnsRecords = pgTable(
  "dns_records",
  {
    id: id(),
    zoneId: uuid("zone_id")
      .notNull()
      .references(() => dnsZones.id, { onDelete: "cascade" }),
    /** Relative to the zone: "@" for the apex, "www", "*.dev"… */
    name: text("name").notNull(),
    type: text("type").$type<DnsType>().notNull(),
    value: text("value").notNull(),
    ttl: integer("ttl").notNull().default(3600),
    priority: integer("priority").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("dns_records_zone_idx").on(t.zoneId)],
);

/** External availability checks of a workload's primary hostname. */
export const uptimeChecks = pgTable(
  "uptime_checks",
  {
    id: id(),
    workloadId: uuid("workload_id")
      .notNull()
      .references(() => workloads.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ok: boolean("ok").notNull(),
    /** HTTP status, or 0 when the request itself failed. */
    status: integer("status").notNull().default(0),
    ms: integer("ms").notNull().default(0),
    error: text("error").notNull().default(""),
  },
  (t) => [index("uptime_checks_idx").on(t.workloadId, t.at)],
);

/** Resource samples reported by agents, one row per workload every few minutes. */
export const workloadMetrics = pgTable(
  "workload_metrics",
  {
    id: id(),
    workloadId: uuid("workload_id")
      .notNull()
      .references(() => workloads.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    cpuPercent: integer("cpu_percent").notNull().default(0),
    memMb: integer("mem_mb").notNull().default(0),
    /** Cumulative network counters of the container, in MB. */
    rxMb: integer("rx_mb").notNull().default(0),
    txMb: integer("tx_mb").notNull().default(0),
  },
  (t) => [index("workload_metrics_idx").on(t.workloadId, t.at)],
);

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Unit of work executed by a node agent. See src/platform/protocol.ts. */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    workloadId: uuid("workload_id").references(() => workloads.id, { onDelete: "set null" }),
    backupId: uuid("backup_id"),
    deploymentId: uuid("deployment_id"),
    type: text("type").notNull(),
    /** Self-contained instructions for the agent. May embed secrets, so it is encrypted. */
    payload: text("payload").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    actorId: uuid("actor_id"),
    error: text("error").notNull().default(""),
    log: text("log").notNull().default(""),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_node_status_idx").on(t.nodeId, t.status), index("jobs_workload_idx").on(t.workloadId)],
);

/** Named monotonic counters. Incremented inside the caller's transaction, so a rollback leaves no gap. */
export const counters = pgTable("counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull().default(0),
});

// ─── Domain names ────────────────────────────────────────────────────────────

/** A TLD on sale: which registrar serves it and what a year costs (cents). */
export const domainTlds = pgTable("domain_tlds", {
  id: id(),
  /** Without the leading dot: `com`, `it`, `co.uk`. */
  tld: text("tld").notNull().unique(),
  registrar: text("registrar").notNull(),
  registerPrice: integer("register_price").notNull(),
  renewPrice: integer("renew_price").notNull(),
  transferPrice: integer("transfer_price").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sort: integer("sort").notNull().default(0),
});

export type DomainStatus = "pending" | "active" | "transferring" | "expired" | "failed" | "cancelled";

/** A domain name registered or transferred through a registrar module. Billed through its service. */
export const domainNames = pgTable(
  "domain_names",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    name: text("name").notNull().unique(),
    registrar: text("registrar").notNull(),
    status: text("status").$type<DomainStatus>().notNull().default("pending"),
    statusMessage: text("status_message").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    nameservers: jsonb("nameservers").$type<string[]>().notNull().default([]),
    locked: boolean("locked").notNull().default(true),
    /** Registrant snapshot used for the registration. */
    contact: jsonb("contact").$type<Record<string, string>>().notNull().default({}),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("domain_names_company_idx").on(t.companyId)],
);

// ─── API keys & webhooks ─────────────────────────────────────────────────────

/** A company's credential for the REST API. Only the hash of the token is stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters of the token, to recognise it in lists. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** `read` may only GET. */
    scope: text("scope").$type<"read" | "write">().notNull().default("read"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_company_idx").on(t.companyId)],
);

/** An endpoint of the customer's that receives signed event notifications. */
export const webhooks = pgTable(
  "webhooks",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Encrypted signing secret. */
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastStatus: text("last_status").notNull().default(""),
    lastAt: timestamp("last_at", { withTimezone: true }),
    failures: integer("failures").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("webhooks_company_idx").on(t.companyId)],
);

/** Every movement of a company's prepaid balance: the balance is always the sum of these rows. */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Positive = added, negative = spent. */
    amount: integer("amount").notNull(),
    reason: text("reason").notNull().default(""),
    invoiceId: uuid("invoice_id"),
    actorId: uuid("actor_id"),
    createdAt: createdAt(),
  },
  (t) => [index("credit_ledger_company_idx").on(t.companyId)],
);

/** A card kept at the gateway; we only hold its reference and what is printed on it. */
export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    gateway: text("gateway").notNull().default("stripe"),
    externalId: text("external_id").notNull().unique(),
    brand: text("brand").notNull().default(""),
    last4: text("last4").notNull().default(""),
    expMonth: integer("exp_month").notNull().default(0),
    expYear: integer("exp_year").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("payment_methods_company_idx").on(t.companyId)],
);

// ─── Coupons, canned replies, incidents ──────────────────────────────────────

/** A discount on the first invoice of an order. Renewals stay at list price. */
export const coupons = pgTable("coupons", {
  id: id(),
  /** Upper case, unique. */
  code: text("code").notNull().unique(),
  kind: text("kind").$type<"percent" | "fixed">().notNull(),
  /** Percent (1-100) or cents. */
  value: integer("value").notNull(),
  /** 0 = unlimited. */
  maxUses: integer("max_uses").notNull().default(0),
  used: integer("used").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

/** Ready-made answers staff can drop into a ticket reply. */
export const cannedReplies = pgTable("canned_replies", {
  id: id(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

/** What the public status page shows. `updates` is the timeline, newest last. */
export const incidents = pgTable("incidents", {
  id: id(),
  title: text("title").notNull(),
  impact: text("impact").$type<"minor" | "major" | "maintenance">().notNull().default("minor"),
  status: text("status").$type<IncidentStatus>().notNull().default("investigating"),
  updates: jsonb("updates").$type<{ at: string; status: IncidentStatus; message: string }[]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ─── Support ─────────────────────────────────────────────────────────────────

export type TicketStatus = "open" | "answered" | "customer_reply" | "closed";
export type TicketPriority = "low" | "medium" | "high";

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    number: serial("number").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    department: text("department").notNull().default("support"),
    subject: text("subject").notNull(),
    priority: text("priority").$type<TicketPriority>().notNull().default("medium"),
    status: text("status").$type<TicketStatus>().notNull().default("open"),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("tickets_client_idx").on(t.clientId), index("tickets_status_idx").on(t.status)],
);

export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: id(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId)],
);

// ─── Email log ───────────────────────────────────────────────────────────────

export type EmailStatus = "sent" | "failed";

export const emailLog = pgTable(
  "email_log",
  {
    id: id(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    template: text("template").notNull(),
    status: text("status").$type<EmailStatus>().notNull(),
    error: text("error").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("email_log_created_idx").on(t.createdAt), index("email_log_user_idx").on(t.userId)],
);

/** Admin overrides of the built-in email templates (see src/lib/mail/templates.ts). */
export const emailTemplates = pgTable("email_templates", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  /** Empty string = use the built-in, translated default. */
  subject: text("subject").notNull().default(""),
  heading: text("heading").notNull().default(""),
  body: text("body").notNull().default(""),
  updatedAt: updatedAt(),
});

// ─── Audit ───────────────────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entity: text("entity").notNull().default(""),
    entityId: text("entity_id").notNull().default(""),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

// ─── Relations ───────────────────────────────────────────────────────────────

export const productGroupsRelations = relations(productGroups, ({ many }) => ({
  products: many(products),
}));

export const productsRelations = relations(products, ({ one }) => ({
  group: one(productGroups, { fields: [products.groupId], references: [productGroups.id] }),
  server: one(servers, { fields: [products.serverId], references: [servers.id] }),
}));

export const servicesRelations = relations(services, ({ one }) => ({
  client: one(users, { fields: [services.clientId], references: [users.id] }),
  product: one(products, { fields: [services.productId], references: [products.id] }),
  server: one(servers, { fields: [services.serverId], references: [servers.id] }),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  client: one(users, { fields: [orders.clientId], references: [users.id] }),
  services: many(services),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  client: one(users, { fields: [invoices.clientId], references: [users.id] }),
  items: many(invoiceItems),
  transactions: many(transactions),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }),
  service: one(services, { fields: [invoiceItems.serviceId], references: [services.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  invoice: one(invoices, { fields: [transactions.invoiceId], references: [invoices.id] }),
}));

export const nodesRelations = relations(nodes, ({ many }) => ({ workloads: many(workloads) }));

export const workloadsRelations = relations(workloads, ({ one, many }) => ({
  client: one(users, { fields: [workloads.clientId], references: [users.id] }),
  node: one(nodes, { fields: [workloads.nodeId], references: [nodes.id] }),
  service: one(services, { fields: [workloads.serviceId], references: [services.id] }),
  parent: one(workloads, { fields: [workloads.parentId], references: [workloads.id], relationName: "staging" }),
  staging: many(workloads, { relationName: "staging" }),
  domains: many(domains),
  backups: many(backups),
  deployments: many(deployments),
  jobs: many(jobs),
}));

export const domainsRelations = relations(domains, ({ one }) => ({
  workload: one(workloads, { fields: [domains.workloadId], references: [workloads.id] }),
}));
export const backupsRelations = relations(backups, ({ one }) => ({
  workload: one(workloads, { fields: [backups.workloadId], references: [workloads.id] }),
}));
export const deploymentsRelations = relations(deployments, ({ one }) => ({
  workload: one(workloads, { fields: [deployments.workloadId], references: [workloads.id] }),
}));
export const dnsZonesRelations = relations(dnsZones, ({ many }) => ({ records: many(dnsRecords) }));
export const dnsRecordsRelations = relations(dnsRecords, ({ one }) => ({ zone: one(dnsZones, { fields: [dnsRecords.zoneId], references: [dnsZones.id] }) }));

export const jobsRelations = relations(jobs, ({ one }) => ({
  node: one(nodes, { fields: [jobs.nodeId], references: [nodes.id] }),
  workload: one(workloads, { fields: [jobs.workloadId], references: [workloads.id] }),
}));

export const ticketsRelations = relations(tickets, ({ one, many }) => ({
  client: one(users, { fields: [tickets.clientId], references: [users.id] }),
  messages: many(ticketMessages),
}));

export const ticketMessagesRelations = relations(ticketMessages, ({ one }) => ({
  ticket: one(tickets, { fields: [ticketMessages.ticketId], references: [tickets.id] }),
  author: one(users, { fields: [ticketMessages.authorId], references: [users.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actor: one(users, { fields: [auditLog.actorId], references: [users.id] }),
}));
