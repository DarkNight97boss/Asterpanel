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
    { value: "center", label: "Center" },
    { value: "left", label: "Left" },
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
      align: "center",
    },
  },
  {
    type: "pricing",
    label: "Pricing table",
    description: "Live plans and prices from a product group.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      { name: "groupId", label: "Product group", type: "productGroup" },
    ],
    defaults: { title: "Choose your plan", subtitle: "", groupId: "" },
  },
  {
    type: "features",
    label: "Features grid",
    description: "Grid of icon + title + text cards.",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "subtitle", label: "Subtitle", type: "textarea" },
      {
        name: "items",
        label: "Features",
        type: "list",
        itemLabel: "Feature",
        fields: [
          { name: "icon", label: "Icon (emoji)", type: "text" },
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
    ],
    defaults: { title: "Ready to get started?", text: "", label: "Get started", href: "/register" },
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
