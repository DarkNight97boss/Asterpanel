"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Textarea, cn } from "@/components/ui";
import { useT } from "@/i18n/client";
import { BLOCKS, blockDef, items, str, type Block, type BlockProps, type FieldDef } from "./blocks";

type Group = { id: string; name: string };

/**
 * Page builder. Holds the block list in state and mirrors it into a hidden
 * `blocks` input, so the surrounding <form> posts it like any other field.
 */
export function BlockEditor({ initial, groups }: { initial: Block[]; groups: Group[] }) {
  const t = useT();
  const [blocks, setBlocks] = useState(initial);
  const [open, setOpen] = useState<string | null>(null);

  const update = (id: string, props: BlockProps) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, props } : b)));
  const move = (index: number, delta: number) =>
    setBlocks((bs) => {
      const next = [...bs];
      const [moved] = next.splice(index, 1);
      next.splice(index + delta, 0, moved);
      return next;
    });
  const add = (type: string) => {
    const def = blockDef(type)!;
    const block: Block = { id: crypto.randomUUID(), type, props: structuredClone(def.defaults) };
    if (type === "pricing" && groups[0]) block.props.groupId = groups[0].id;
    setBlocks((bs) => [...bs, block]);
    setOpen(block.id);
  };

  return (
    <div className="space-y-3">
      <input type="hidden" name="blocks" value={JSON.stringify(blocks)} />

      {blocks.length === 0 && <p className="rounded-theme border border-dashed border-border p-8 text-center text-sm text-muted">{t("This page is empty. Add your first block below.")}</p>}

      {blocks.map((block, index) => {
        const def = blockDef(block.type);
        if (!def) return null;
        const expanded = open === block.id;
        const summary = str(block.props.title) || str(block.props.content).slice(0, 60);
        return (
          <div key={block.id} className={cn("rounded-theme border bg-surface", expanded ? "border-accent" : "border-border")}>
            <div className="flex items-center gap-2 px-4 py-3">
              <button type="button" onClick={() => setOpen(expanded ? null : block.id)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left">
                <span className="rounded bg-subtle px-2 py-0.5 text-xs font-semibold">{t(def.label)}</span>
                <span className="truncate text-sm text-muted">{summary}</span>
              </button>
              <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("Move up")}>↑</Button>
              <Button type="button" size="sm" variant="ghost" disabled={index === blocks.length - 1} onClick={() => move(index, 1)} aria-label={t("Move down")}>↓</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setBlocks((bs) => bs.filter((b) => b.id !== block.id))} aria-label={t("Remove")}>✕</Button>
            </div>
            {expanded && (
              <div className="border-t border-border p-4">
                <Fields fields={def.fields} value={block.props} groups={groups} onChange={(props) => update(block.id, props)} />
              </div>
            )}
          </div>
        );
      })}

      <div className="rounded-theme border border-dashed border-border p-4">
        <p className="mb-3 text-sm font-medium">{t("Add a block")}</p>
        <div className="flex flex-wrap gap-2">
          {BLOCKS.map((b) => (
            <Button key={b.type} type="button" size="sm" variant="secondary" onClick={() => add(b.type)} title={t(b.description)}>
              + {t(b.label)}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Fields({
  fields,
  value,
  groups,
  onChange,
}: {
  fields: FieldDef[];
  value: BlockProps;
  groups: Group[];
  onChange: (next: BlockProps) => void;
}) {
  const t = useT();
  const set = (name: string, v: unknown) => onChange({ ...value, [name]: v });

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {fields.map((f) => {
        if (f.type === "list") {
          const list = items(value[f.name]);
          const blank = Object.fromEntries(f.fields.map((sf) => [sf.name, ""]));
          return (
            <div key={f.name} className="sm:col-span-2">
              <p className="mb-2 text-sm font-medium">{t(f.label)}</p>
              <div className="space-y-3">
                {list.map((item, i) => (
                  <div key={i} className="rounded-theme border border-border bg-subtle p-3">
                    <div className="mb-2 flex items-center justify-between text-xs text-muted">
                      <span>{t(f.itemLabel)} {i + 1}</span>
                      <button type="button" className="cursor-pointer hover:text-danger" onClick={() => set(f.name, list.filter((_, n) => n !== i))}>
                        {t("Remove")}
                      </button>
                    </div>
                    <Fields fields={f.fields} value={item} groups={groups} onChange={(next) => set(f.name, list.map((it, n) => (n === i ? next : it)))} />
                  </div>
                ))}
                <Button type="button" size="sm" variant="secondary" onClick={() => set(f.name, [...list, blank])}>
                  + {t(f.itemLabel)}
                </Button>
              </div>
            </div>
          );
        }

        const v = str(value[f.name]);
        const wide = f.type === "textarea" || f.type === "markdown";
        return (
          <Field key={f.name} label={t(f.label)} className={wide ? "sm:col-span-2" : undefined}>
            {f.type === "select" ? (
              <Select value={v} onChange={(e) => set(f.name, e.target.value)}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
              </Select>
            ) : f.type === "productGroup" ? (
              <Select value={v} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">—</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </Select>
            ) : wide ? (
              <Textarea value={v} rows={f.type === "markdown" ? 14 : 3} className={f.type === "markdown" ? "font-mono" : undefined} onChange={(e) => set(f.name, e.target.value)} />
            ) : (
              <Input value={v} placeholder={f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}
