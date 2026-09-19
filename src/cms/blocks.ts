/**
 * Block registry for the site builder.
 *
 * A page is an ordered list of blocks. Every block type declares its fields
 * here once; the admin editor builds its form from these definitions and the
 * renderer (`./render.tsx`) reads the same props. Adding a block type means:
 * add a definition below + a renderer case. No database change is required.
 */

export type FieldDef =
  | { name: string; label: string; type: "text" | "textarea" | "url" | "markdown"; placeholder?: string }
  | { name: string; label: string; type: "select"; options: { value: string; label: string }[] }
  | { name: string; label: string; type: "productGroup" }
  | { name: string; label: string; type: "list"; itemLabel: string; fields: FieldDef[] };

export type BlockProps = Record<string, unknown>;
export type Block = { id: string; type: string; props: BlockProps };

export type BlockDef = {
  type: string;
  label: string;
  description: string;
  fields: FieldDef[];
  defaults: BlockProps;
};

const align: FieldDef = {
  name: "align",
  label: "Alignment",
  type: "select",
  options: [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
  ],
};

export const BLOCKS: BlockDef[] = [
  {
    type: "hero",
    label: "Hero",
    description: "Large headline with call-to-action buttons.",
    fields: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Title", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      { name: "primaryLabel", label: "Primary button label", type: "text" },
      { name: "primaryHref", label: "Primary button link", type: "url" },
      { name: "secondaryLabel", label: "Secondary button label", type: "text" },
      { name: "secondaryHref", label: "Secondary button link", type: "url" },
      { name: "imageUrl", label: "Image URL (optional)", type: "url" },
      align,
    ],
    defaults: {
      eyebrow: "",
      title: "Fast, reliable hosting",
      subtitle: "Everything you need to put your project online.",
      primaryLabel: "View plans",
      primaryHref: "#pricing",
      secondaryLabel: "",
      secondaryHref: "",
      imageUrl: "",
      align: "left",
    },
  },
  {
    type: "pricing",
    label: "Pricing table",
    description: "Live plans and prices from a product group.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "titleMuted", label: "Title, second line (muted)", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      { name: "groupId", label: "Product group", type: "productGroup" },
    ],
    defaults: { title: "Choose your plan", subtitle: "", groupId: "" },
  },
  {
    type: "proof",
    label: "Social proof panel",
    description: "Dark rounded panel with a rating, a headline and customer quotes.",
    fields: [
      { name: "rating", label: "Rating", type: "text", placeholder: "4.8/5" },
      { name: "title", label: "Title", type: "text" },
      { name: "note", label: "Small note", type: "text" },
      { name: "label", label: "Button label", type: "text" },
      { name: "href", label: "Button link", type: "url" },
      {
        name: "items",
        label: "Quotes",
        type: "list",
        itemLabel: "Quote",
        fields: [
          { name: "headline", label: "Headline", type: "text" },
          { name: "quote", label: "Quote", type: "textarea" },
          { name: "author", label: "Author", type: "text" },
          { name: "role", label: "Role / company", type: "text" },
        ],
      },
    ],
    defaults: {
      rating: "4.9/5",
      title: "Loved by the teams who host with us",
      note: "Replace these quotes with your customers' words.",
      label: "Make the switch today",
      href: "/register",
      items: [
        { headline: "A perfect experience", quote: "Staging, backups and deploys in one place. We moved every client site in a weekend.", author: "Giulia R.", role: "Web agency" },
        { headline: "Fast and predictable", quote: "Isolated containers mean a busy neighbour never slows our shop down.", author: "Marco T.", role: "E-commerce" },
        { headline: "Support that answers", quote: "Real engineers reply in minutes, and they actually fix things.", author: "Sara L.", role: "SaaS founder" },
      ],
    },
  },
  {
    type: "services",
    label: "Services",
    description: "Large cards, one per product line, each with its own link.",
    fields: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Title", type: "text" },
      { name: "titleMuted", label: "Title, second line (muted)", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      {
        name: "items",
        label: "Services",
        type: "list",
        itemLabel: "Service",
        fields: [
          { name: "icon", label: "Icon (emoji)", type: "text" },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Text", type: "textarea" },
          { name: "linkLabel", label: "Link label", type: "text" },
          { name: "href", label: "Link", type: "url" },
        ],
      },
    ],
    defaults: {
      eyebrow: "One platform",
      title: "Everything you host, in one dashboard",
      subtitle: "",
      items: [
        { icon: "Ⓦ", title: "Managed WordPress", text: "Isolated containers, one-click staging, backups and free SSL.", linkLabel: "Create a site", href: "/client/new/sites" },
        { icon: "▲", title: "Application Hosting", text: "Deploy any Dockerfile from Git. Push to deploy, env vars, logs.", linkLabel: "Deploy an app", href: "/client/new/apps" },
        { icon: "◉", title: "Managed Databases", text: "MySQL, PostgreSQL and Redis on your private network.", linkLabel: "Create a database", href: "/client/new/databases" },
        { icon: "◇", title: "Static Sites", text: "Build from Git and serve with automatic HTTPS. Free.", linkLabel: "Publish a site", href: "/client/new/static-sites" },
      ],
    },
  },
  {
    type: "split",
    label: "Split (text + panel)",
    description: "Text and bullet points beside a terminal-style panel.",
    fields: [
      { name: "eyebrow", label: "Eyebrow", type: "text" },
      { name: "title", label: "Title", type: "text" },
      { name: "text", label: "Text", type: "textarea" },
      { name: "bullets", label: "Bullets", type: "list", itemLabel: "Bullet", fields: [{ name: "text", label: "Text", type: "text" }] },
      { name: "label", label: "Button label", type: "text" },
      { name: "href", label: "Button link", type: "url" },
      { name: "panelTitle", label: "Panel title", type: "text" },
      { name: "panel", label: "Panel content (one line per row)", type: "textarea" },
      {
        name: "side",
        label: "Panel position",
        type: "select",
        options: [
          { value: "right", label: "Right" },
          { value: "left", label: "Left" },
        ],
      },
    ],
    defaults: {
      eyebrow: "",
      title: "Push to deploy",
      text: "Connect a repository and every push goes live. A failed build never takes your site down.",
      bullets: [{ text: "Build logs in real time" }, { text: "Encrypted environment variables" }, { text: "Automatic HTTPS on every domain" }],
      label: "",
      href: "",
      panelTitle: "deploy",
      panel: "$ git push origin main\n→ cloning repository\n→ building image\n→ starting container\n✓ live at https://app.example.com",
      side: "right",
    },
  },
  {
    type: "logos",
    label: "Logo strip",
    description: "A row of names: technologies, customers or partners.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "items", label: "Names", type: "list", itemLabel: "Name", fields: [{ name: "name", label: "Name", type: "text" }] },
    ],
    defaults: { title: "Built on technology you already trust", items: [{ name: "Docker" }, { name: "WordPress" }, { name: "PostgreSQL" }, { name: "MariaDB" }, { name: "Redis" }, { name: "Let's Encrypt" }] },
  },
  {
    type: "features",
    label: "Features grid",
    description: "Grid of icon + title + text cards.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "titleMuted", label: "Title, second line (muted)", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      {
        name: "items",
        label: "Features",
        type: "list",
        itemLabel: "Feature",
        fields: [
          { name: "icon", label: "Icon (emoji)", type: "text" },
          { name: "imageUrl", label: "Image URL (optional)", type: "url" },
          { name: "title", label: "Title", type: "text" },
          { name: "text", label: "Text", type: "textarea" },
        ],
      },
    ],
    defaults: {
      title: "Why choose us",
      subtitle: "",
      items: [
        { icon: "⚡", title: "NVMe storage", text: "Blazing fast disks on every plan." },
        { icon: "🔒", title: "Free SSL", text: "Automatic certificates for all your domains." },
        { icon: "💬", title: "Real support", text: "Talk to engineers, not scripts." },
      ],
    },
  },
  {
    type: "stats",
    label: "Stats",
    description: "Row of big numbers.",
    fields: [
      {
        name: "items",
        label: "Stats",
        type: "list",
        itemLabel: "Stat",
        fields: [
          { name: "value", label: "Value", type: "text" },
          { name: "label", label: "Label", type: "text" },
        ],
      },
    ],
    defaults: {
      items: [
        { value: "99.99%", label: "Uptime" },
        { value: "24/7", label: "Support" },
        { value: "<1 min", label: "Activation" },
      ],
    },
  },
  {
    type: "testimonials",
    label: "Testimonials",
    description: "Customer quotes.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      {
        name: "items",
        label: "Quotes",
        type: "list",
        itemLabel: "Quote",
        fields: [
          { name: "quote", label: "Quote", type: "textarea" },
          { name: "author", label: "Author", type: "text" },
          { name: "role", label: "Role / company", type: "text" },
        ],
      },
    ],
    defaults: { title: "What our customers say", items: [] },
  },
  {
    type: "faq",
    label: "FAQ",
    description: "Expandable questions and answers.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      {
        name: "items",
        label: "Questions",
        type: "list",
        itemLabel: "Question",
        fields: [
          { name: "q", label: "Question", type: "text" },
          { name: "a", label: "Answer", type: "textarea" },
        ],
      },
    ],
    defaults: { title: "Frequently asked questions", items: [] },
  },
  {
    type: "richtext",
    label: "Rich text",
    description: "Free content written in Markdown.",
    fields: [{ name: "content", label: "Content (Markdown)", type: "markdown" }],
    defaults: { content: "## Title\n\nWrite your content here." },
  },
  {
    type: "cta",
    label: "Call to action",
    description: "Highlighted banner with a button.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "text", label: "Text", type: "textarea" },
      { name: "label", label: "Button label", type: "text" },
      { name: "href", label: "Button link", type: "url" },
      { name: "secondaryLabel", label: "Secondary button label", type: "text" },
      { name: "secondaryHref", label: "Secondary button link", type: "url" },
      {
        name: "style",
        label: "Style",
        type: "select",
        options: [
          { value: "dark", label: "Dark panel" },
          { value: "strip", label: "Light strip" },
        ],
      },
    ],
    defaults: { title: "Ready to get started?", text: "", label: "Get started", href: "/register", secondaryLabel: "", secondaryHref: "", style: "dark" },
  },
];

export const blockDef = (type: string) => BLOCKS.find((b) => b.type === type);

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const items = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((i): i is Record<string, unknown> => !!i && typeof i === "object") : [];

/**
 * Coerces untrusted editor output into well-formed blocks: unknown types are
 * dropped, unknown props stripped, every value forced to the declared shape.
 */
export function sanitizeBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) return [];
  const out: Block[] = [];
  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const { id, type, props } = raw as Partial<Block>;
    const def = typeof type === "string" ? blockDef(type) : undefined;
    if (!def) continue;
    out.push({
      id: typeof id === "string" && id ? id.slice(0, 64) : crypto.randomUUID(),
      type: def.type,
      props: sanitizeFields(def.fields, (props ?? {}) as BlockProps),
    });
  }
  return out;
}

function sanitizeFields(fields: FieldDef[], props: BlockProps): BlockProps {
  const clean: BlockProps = {};
  for (const f of fields) {
    const v = props[f.name];
    if (f.type === "list") {
      clean[f.name] = items(v)
        .slice(0, 50)
        .map((i) => sanitizeFields(f.fields, i));
    } else if (f.type === "select") {
      clean[f.name] = f.options.some((o) => o.value === v) ? v : f.options[0].value;
    } else {
      clean[f.name] = str(v).slice(0, f.type === "markdown" ? 50_000 : 2_000);
    }
  }
  return clean;
}

/** Links typed by editors: allow relative, anchor, http(s), mailto and tel only. */
export function safeHref(href: unknown): string {
  const h = str(href).trim();
  return /^(\/|#|https?:\/\/|mailto:|tel:)/i.test(h) ? h : "#";
}
