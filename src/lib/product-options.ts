import type { ProductAddon, ProductOption } from "@/db/schema";
import { parseMoney, slugify } from "./format";

/**
 * Configurable options of a product: a choice among priced alternatives
 * ("Backups kept: 7 / 30 / 90 days") or a quantity of something priced per
 * unit ("Extra disk, 10 GB blocks"). Pure. What the customer picks becomes
 * add-on lines of the order, so prices, invoices, renewals and resources
 * follow the same path as fixed add-ons.
 */

export class OptionError extends Error {}

export const MAX_OPTIONS = 10;
const num = (raw: string | undefined, max: number) => Math.min(max, Math.max(0, Math.round(Number(raw) || 0)));
const resources = (ram: string | undefined, disk: string | undefined) => ({ memoryMb: num(ram, 65_536) || undefined, diskGb: num(disk, 2000) || undefined });

/**
 * One option per line:
 *   choice   | Backups kept | 7 days = 0 ; 30 days = 3.00 ; 90 days = 8.00
 *   choice   | Memory       | 1 GB = 0 ; 2 GB = 4.00 / 1024 ; 4 GB = 10.00 / 3072 / 5     (price / +RAM MB / +disk GB)
 *   quantity | Extra disk (10 GB) | 2.00 | 0 | 20 | 0 | 10                                 (unit price | min | max | RAM MB per unit | disk GB per unit)
 */
export function parseOptionLines(text: string): ProductOption[] {
  const options: ProductOption[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const bad = () => new OptionError(`This option line is not understood: ${raw.trim().slice(0, 60)}`);
    const [kind, name, ...rest] = raw.split("|").map((x) => x.trim());
    if (!name || name.length > 60) throw bad();
    const id = slugify(name).slice(0, 40) || `option-${options.length + 1}`;
    if (kind.toLowerCase() === "choice") {
      const choices = (rest[0] ?? "").split(";").map((c) => c.trim()).filter(Boolean).map((c, i) => {
        const [label, value = ""] = c.split("=").map((x) => x.trim());
        const [price, ram, disk] = value.split("/").map((x) => x.trim());
        const monthly = parseMoney(price ?? "");
        if (!label || label.length > 60 || monthly === null) throw bad();
        return { id: slugify(label).slice(0, 40) || `choice-${i + 1}`, name: label, monthly, ...resources(ram, disk) };
      });
      if (choices.length < 2 || choices.length > 12 || new Set(choices.map((c) => c.id)).size !== choices.length) throw bad();
      options.push({ id, name, kind: "choice", choices });
    } else if (kind.toLowerCase() === "quantity") {
      const monthly = parseMoney(rest[0] ?? "");
      const min = num(rest[1], 1000);
      const max = num(rest[2], 1000) || 10;
      if (monthly === null || min > max) throw bad();
      options.push({ id, name, kind: "quantity", unit: { monthly, ...resources(rest[3], rest[4]) }, min, max });
    } else throw bad();
  }
  if (options.length > MAX_OPTIONS || new Set(options.map((o) => o.id)).size !== options.length) throw new OptionError(`Up to ${MAX_OPTIONS} options, each with its own name`);
  return options;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const tail = (r: { memoryMb?: number; diskGb?: number }) => (r.diskGb ? ` / ${r.memoryMb ?? 0} / ${r.diskGb}` : r.memoryMb ? ` / ${r.memoryMb}` : "");

/** The reverse, for the editor. */
export const formatOptionLines = (options: ProductOption[]) =>
  options
    .map((o) => (o.kind === "choice" ? `choice | ${o.name} | ${o.choices.map((c) => `${c.name} = ${money(c.monthly)}${tail(c)}`).join(" ; ")}` : `quantity | ${o.name} | ${money(o.unit.monthly)} | ${o.min} | ${o.max} | ${o.unit.memoryMb ?? 0} | ${o.unit.diskGb ?? 0}`))
    .join("\n");

/**
 * What was picked, as add-on lines. A choice always has a value (the first
 * one when nothing was sent); anything not on offer refuses the order rather
 * than being priced at zero.
 */
export function resolveOptions(options: ProductOption[], picked: Record<string, string>): ProductAddon[] {
  const lines: ProductAddon[] = [];
  for (const o of options) {
    const value = picked[o.id];
    if (o.kind === "choice") {
      const choice = value === undefined || value === "" ? o.choices[0] : o.choices.find((c) => c.id === value);
      if (!choice) throw new OptionError(`${o.name}: this choice is not available`);
      // The free default is not worth a line on the invoice.
      if (choice.monthly || choice.memoryMb || choice.diskGb) lines.push({ id: `opt:${o.id}:${choice.id}`, name: `${o.name}: ${choice.name}`, monthly: choice.monthly, memoryMb: choice.memoryMb, diskGb: choice.diskGb });
    } else {
      const qty = value === undefined || value === "" ? o.min : Number(value);
      if (!Number.isInteger(qty) || qty < o.min || qty > o.max) throw new OptionError(`${o.name}: choose between ${o.min} and ${o.max}`);
      if (qty > 0) lines.push({ id: `opt:${o.id}:${qty}`, name: `${o.name} × ${qty}`, monthly: o.unit.monthly * qty, memoryMb: (o.unit.memoryMb ?? 0) * qty || undefined, diskGb: (o.unit.diskGb ?? 0) * qty || undefined });
    }
  }
  return lines;
}

/** `option:<id>` fields of an order form. */
export const pickedFrom = (form: FormData) => Object.fromEntries([...form.entries()].filter(([k, v]) => k.startsWith("option:") && typeof v === "string").map(([k, v]) => [k.slice(7), String(v).slice(0, 60)]));
