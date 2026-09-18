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
export type UserStatus = "active" | "suspended" | "closed";

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<UserRole>().notNull().default("client"),
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
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

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
    number: serial("number").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status").$type<InvoiceStatus>().notNull().default("unpaid"),
    currency: text("currency").notNull(),
    subtotal: integer("subtotal").notNull().default(0),
    /** Basis points, e.g. 2200 = 22%. */
    taxRate: integer("tax_rate").notNull().default(0),
    tax: integer("tax").notNull().default(0),
    total: integer("total").notNull().default(0),
    dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    notes: text("notes").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("invoices_client_idx").on(t.clientId), index("invoices_status_idx").on(t.status)],
);

export type InvoiceItemKind = "new" | "renewal" | "setup" | "custom";

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

// ─── Support ─────────────────────────────────────────────────────────────────

export type TicketStatus = "open" | "answered" | "customer_reply" | "closed";
export type TicketPriority = "low" | "medium" | "high";

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    number: serial("number").notNull(),
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
