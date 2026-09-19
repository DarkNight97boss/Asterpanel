"use client";

import { Select } from "./ui";

/** Appends the chosen canned reply to the textarea with the given id. */
export function CannedPicker({ target, replies, placeholder }: { target: string; replies: { title: string; body: string }[]; placeholder: string }) {
  if (!replies.length) return null;
  return (
    <Select
      aria-label={placeholder}
      defaultValue=""
      className="max-w-xs"
      onChange={(e) => {
        const reply = replies[Number(e.target.value)];
        const area = document.getElementById(target) as HTMLTextAreaElement | null;
        if (reply && area) {
          area.value = area.value ? `${area.value.trimEnd()}\n\n${reply.body}` : reply.body;
          area.focus();
        }
        e.target.value = "";
      }}
    >
      <option value="">{placeholder}</option>
      {replies.map((r, i) => <option key={i} value={i}>{r.title}</option>)}
    </Select>
  );
}
