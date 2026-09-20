import { Field, Input, Select } from "@/components/ui";
import type { ProductOption } from "@/db/schema";

/** The configurable options of a product inside an order form. Field names are `option:<id>`, optionally prefixed per product. */
export function OptionFields({ options, money, perMonth, prefix = "" }: { options: ProductOption[]; money: (cents: number) => string; perMonth: string; prefix?: string }) {
  if (!options.length) return null;
  return (
    <>
      {options.map((o) =>
        o.kind === "choice" ? (
          <Field key={o.id} label={o.name}>
            <Select name={`${prefix}option:${o.id}`} defaultValue={o.choices[0].id}>
              {o.choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.monthly ? ` (+${money(c.monthly)}${perMonth})` : ""}</option>)}
            </Select>
          </Field>
        ) : (
          <Field key={o.id} label={o.name} hint={`+${money(o.unit.monthly)}${perMonth} × ${o.min}–${o.max}`}>
            <Input name={`${prefix}option:${o.id}`} type="number" min={o.min} max={o.max} step={1} defaultValue={o.min} />
          </Field>
        ),
      )}
    </>
  );
}
