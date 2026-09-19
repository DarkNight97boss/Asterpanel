import "server-only";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { Block } from "@/cms/blocks";
import { BLOCKS } from "@/cms/blocks";
import { slugify } from "./format";
import { getSettings } from "./settings";

/** Guard for every area except /install: a fresh database goes to the wizard. */
export async function ensureInstalled() {
  if (!(await getSettings("general")).installed) redirect("/install");
}

const block = (type: string, props: Record<string, unknown> = {}): Block => ({
  id: crypto.randomUUID(),
  type,
  props: { ...BLOCKS.find((b) => b.type === type)!.defaults, ...props },
});

/** The platform home page: every block stays editable in Admin → Pages. */
export async function platformHomeBlocks(siteName: string): Promise<Block[]> {
  const db = await getDb();
  const groups = await db.select().from(schema.productGroups);
  const group = (slug: string) => groups.find((g) => g.slug === slug)?.id ?? "";
  return [
    block("hero", {
      eyebrow: `${siteName} · Managed hosting platform`,
      title: "Hosting for sites that mean business",
      subtitle: "WordPress, applications, databases and static sites on isolated containers — with staging, backups, push-to-deploy and free SSL, all from one dashboard.",
      primaryLabel: "Start now",
      primaryHref: "/register",
      secondaryLabel: "See pricing",
      secondaryHref: "#pricing",
    }),
    block("proof", { title: `Teams switch to ${siteName} and stay` }),
    block("features", {
      title: `Why teams move to ${siteName}`,
      titleMuted: "",
      items: [
        { icon: "▣", title: "Isolated containers for each site, to guarantee security and performance", text: "" },
        { icon: "⇄", title: "One-click staging, backups and restores on every WordPress site", text: "" },
        { icon: "▲", title: "Push-to-deploy applications, databases and static sites on the same platform", text: "" },
      ],
    }),
    block("services", { eyebrow: "", title: "Simply better hosting.", titleMuted: "One dashboard for everything you run.", subtitle: "" }),
    block("split", {
      eyebrow: "Managed WordPress",
      title: "Test on staging. Go live in one click.",
      text: "Every site gets a private copy to try updates safely. When you are happy, push it to production — a backup of the live site is taken first, automatically.",
      bullets: [{ text: "One-click staging environments" }, { text: "Manual and automatic backups, one-click restore" }, { text: "Choose your PHP version per site" }],
      label: "Create a WordPress site",
      href: "/client/new/sites",
      panelTitle: "staging → live",
      panel: "$ push staging to live\n→ backup of live site (84 MB)\n→ copying files\n→ copying database\n→ rewriting URLs\n✓ live in 38 seconds",
      side: "right",
    }),
    block("split", { eyebrow: "Application hosting", side: "left", label: "Deploy an app", href: "/client/new/apps" }),
    block("stats", { items: [{ value: "99.99%", label: "uptime" }, { value: "<60s", label: "from order to online" }, { value: "24/7", label: "human support" }] }),
    block("pricing", { title: "Managed WordPress plans", titleMuted: "Everything included.", subtitle: "", groupId: group("managed-wordpress") }),
    block("pricing", { title: "Application hosting", subtitle: "", groupId: group("application-hosting") }),
    block("cta", { style: "strip", title: "Start now! Create a site in 2 minutes.", text: "", label: "Get started", href: "/register", secondaryLabel: "Talk to us", secondaryHref: "/client/tickets/new" }),
    block("faq", {
      items: [
        { q: "How fast is activation?", a: "Services are created automatically right after payment — usually in under a minute." },
        { q: "Can I use my own domain?", a: "Yes. Add it from the dashboard, point an A record to your server and the SSL certificate is issued automatically." },
        { q: "Do you offer staging?", a: "Every WordPress site includes a staging environment you can create, push to live and delete whenever you want." },
        { q: "What can I deploy as an application?", a: "Anything with a Dockerfile: Node.js, PHP, Python, Go, Ruby… Connect the repository and push to deploy." },
      ],
    }),
    block("cta", { style: "dark", title: "Move today for simply better hosting", text: "Create an account and launch your first service in a minute.", label: "Get started", href: "/register", secondaryLabel: "See pricing", secondaryHref: "#pricing" }),
  ];
}

/** Starter content so a new install looks like a real hosting platform at once. */
export async function seedStarterContent(siteName: string) {
  const db = await getDb();
  await seedPlatformPlans();

  await db.insert(schema.pages).values([
    { slug: "", title: "Home", status: "published", blocks: await platformHomeBlocks(siteName) },
    {
      slug: "terms",
      title: "Terms of Service",
      status: "published",
      blocks: [block("richtext", { content: "## Terms of Service\n\nReplace this text with your terms." })],
    },
  ]);

  await db.insert(schema.menuItems).values([
    { location: "header", label: "WordPress", href: "/client/new/sites", position: 0 },
    { location: "header", label: "Applications", href: "/client/new/apps", position: 1 },
    { location: "header", label: "Pricing", href: "/#pricing", position: 2 },
    { location: "header", label: "Support", href: "/client/tickets", position: 3 },
    ...footerStarter,
  ]);
}

const footerStarter = [
  { location: "footer" as const, columnTitle: "Product", label: "Managed WordPress", href: "/client/new/sites", position: 0 },
  { location: "footer" as const, columnTitle: "Product", label: "Application hosting", href: "/client/new/apps", position: 1 },
  { location: "footer" as const, columnTitle: "Product", label: "Databases", href: "/client/new/databases", position: 2 },
  { location: "footer" as const, columnTitle: "Product", label: "Static sites", href: "/client/new/static-sites", position: 3 },
  { location: "footer" as const, columnTitle: "Company", label: "Pricing", href: "/#pricing", position: 4 },
  { location: "footer" as const, columnTitle: "Company", label: "Support", href: "/client/tickets", position: 5 },
  { location: "footer" as const, columnTitle: "Account", label: "Sign in", href: "/login", position: 6 },
  { location: "footer" as const, columnTitle: "Account", label: "Dashboard", href: "/client", position: 7 },
  { location: "footer" as const, columnTitle: "", label: "Terms of Service", href: "/terms", position: 8 },
];

/** Replaces the footer menu with the starter columns. */
export async function seedFooterColumns() {
  const db = await getDb();
  await db.delete(schema.menuItems).where(eq(schema.menuItems.location, "footer"));
  await db.insert(schema.menuItems).values(footerStarter);
}

/** Starter plans for the built-in platform, one group per service type. */
export async function seedPlatformPlans() {
  const db = await getDb();
  const groups: { slug: string; name: string; description: string; plans: { name: string; tagline: string; price: number; type: string; memoryMb: number; cpus: number; diskGb: number; features: string[]; featured?: boolean }[] }[] = [
    {
      slug: "managed-wordpress",
      name: "Managed WordPress",
      description: "Isolated containers, staging, backups and free SSL.",
      plans: [
        { name: "WP Starter", tagline: "One site, everything included", price: 990, type: "wordpress", memoryMb: 1024, cpus: 1, diskGb: 10, features: ["1 WordPress site", "10 GB NVMe", "Staging environment", "Manual & automatic backups", "Free SSL"] },
        { name: "WP Pro", tagline: "For busy sites and shops", price: 2490, type: "wordpress", memoryMb: 2048, cpus: 2, diskGb: 30, featured: true, features: ["1 WordPress site", "30 GB NVMe", "2 vCPU · 2 GB RAM", "Staging environment", "Priority support"] },
      ],
    },
    {
      slug: "application-hosting",
      name: "Application Hosting",
      description: "Deploy from Git. Any language with a Dockerfile.",
      plans: [
        { name: "App Hobby", tagline: "Side projects and APIs", price: 500, type: "app", memoryMb: 512, cpus: 1, diskGb: 5, features: ["512 MB RAM", "Deploy from Git", "Environment variables", "Free SSL"] },
        { name: "App Standard", tagline: "Production workloads", price: 1500, type: "app", memoryMb: 1024, cpus: 1, diskGb: 10, featured: true, features: ["1 GB RAM", "Deploy on push", "Private network to your databases", "Free SSL"] },
      ],
    },
    {
      slug: "managed-databases",
      name: "Managed Databases",
      description: "MySQL, PostgreSQL and Redis on your private network.",
      plans: [
        { name: "DB Small", tagline: "Development and small apps", price: 400, type: "database", memoryMb: 512, cpus: 1, diskGb: 5, features: ["512 MB RAM", "5 GB storage", "Backups", "Private networking"] },
        { name: "DB Medium", tagline: "Production databases", price: 1200, type: "database", memoryMb: 2048, cpus: 1, diskGb: 20, features: ["2 GB RAM", "20 GB storage", "Backups", "Private networking"] },
      ],
    },
    {
      slug: "static-sites",
      name: "Static Sites",
      description: "Build from Git, served with automatic HTTPS.",
      plans: [{ name: "Static Free", tagline: "Free forever", price: 0, type: "static", memoryMb: 128, cpus: 1, diskGb: 1, features: ["Build from Git", "Custom domains", "Free SSL"] }],
    },
  ];

  for (const [position, g] of groups.entries()) {
    const [group] = await db.insert(schema.productGroups).values({ slug: g.slug, name: g.name, description: g.description, position }).onConflictDoNothing().returning();
    if (!group) continue; // already seeded
    await db.insert(schema.products).values(
      g.plans.map((p, i) => ({
        groupId: group.id,
        slug: slugify(p.name),
        name: p.name,
        tagline: p.tagline,
        features: p.features,
        featured: !!p.featured,
        position: i,
        requiresDomain: false,
        module: "platform",
        moduleConfig: { type: p.type, memoryMb: String(p.memoryMb), cpus: String(p.cpus), diskGb: String(p.diskGb) },
        pricing: p.price ? { monthly: p.price, annually: p.price * 10 } : { monthly: 0 },
      })),
    ).onConflictDoNothing();
  }
}
