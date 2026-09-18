import "server-only";
import { redirect } from "next/navigation";
import { getDb, schema } from "@/db";
import type { Block } from "@/cms/blocks";
import { BLOCKS } from "@/cms/blocks";
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

/** Starter content so a new install looks like a real hosting site at once. */
export async function seedStarterContent(siteName: string) {
  const db = await getDb();

  const [group] = await db
    .insert(schema.productGroups)
    .values({ slug: "web-hosting", name: "Web Hosting", description: "Shared hosting on NVMe storage." })
    .returning();

  const plans = [
    { name: "Starter", tagline: "For your first website", price: 399, features: ["1 website", "10 GB NVMe", "Free SSL", "Daily backups"] },
    { name: "Business", tagline: "For growing projects", price: 899, featured: true, features: ["10 websites", "50 GB NVMe", "Free SSL", "Daily backups", "Staging area"] },
    { name: "Pro", tagline: "For agencies and shops", price: 1699, features: ["Unlimited websites", "150 GB NVMe", "Free SSL", "Hourly backups", "Priority support"] },
  ];
  await db.insert(schema.products).values(
    plans.map((p, position) => ({
      groupId: group.id,
      slug: `hosting-${p.name.toLowerCase()}`,
      name: p.name,
      tagline: p.tagline,
      features: p.features,
      featured: !!p.featured,
      position,
      pricing: { monthly: p.price, annually: p.price * 10 },
    })),
  );

  await db.insert(schema.pages).values([
    {
      slug: "",
      title: "Home",
      status: "published",
      blocks: [
        block("hero", {
          eyebrow: siteName,
          title: "Hosting that just works",
          subtitle: "Fast NVMe servers, free SSL and real human support. Online in under a minute.",
          primaryLabel: "View plans",
          primaryHref: "#pricing",
          secondaryLabel: "Client area",
          secondaryHref: "/client",
        }),
        block("stats"),
        block("pricing", { groupId: group.id }),
        block("features"),
        block("faq", {
          items: [
            { q: "How fast is activation?", a: "Services are activated automatically right after payment." },
            { q: "Can I upgrade later?", a: "Yes, you can change plan at any time from the client area." },
          ],
        }),
        block("cta", { title: "Ready to get online?", text: "Create your account in a minute.", label: "Get started", href: "/register" }),
      ],
    },
    {
      slug: "terms",
      title: "Terms of Service",
      status: "published",
      blocks: [block("richtext", { content: "## Terms of Service\n\nReplace this text with your terms." })],
    },
  ]);

  await db.insert(schema.menuItems).values([
    { location: "header", label: "Hosting", href: "/#pricing", position: 0 },
    { location: "header", label: "Support", href: "/client/tickets", position: 1 },
    { location: "footer", label: "Terms of Service", href: "/terms", position: 0 },
  ]);
}
