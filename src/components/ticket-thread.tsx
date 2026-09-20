import { getLocale, getT } from "@/i18n";
import { displayName, isStaff } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { attachmentsOf } from "@/lib/tickets";
import type { schema } from "@/db";
import { Badge, cn } from "./ui";

/** Columns to load for message authors — never the password hash. */
export const AUTHOR_COLUMNS = { firstName: true, lastName: true, email: true, role: true } as const;

type Message = typeof schema.ticketMessages.$inferSelect & {
  author: Pick<typeof schema.users.$inferSelect, keyof typeof AUTHOR_COLUMNS>;
};

export async function TicketThread({ messages }: { messages: Message[] }) {
  const [t, locale, files] = await Promise.all([getT(), getLocale(), messages[0] ? attachmentsOf(messages[0].ticketId) : new Map<string, never[]>()]);
  const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <ol className="space-y-4">
      {messages.map((m) => {
        const staff = isStaff(m.author);
        return (
          <li key={m.id} className={cn("rounded-theme border bg-surface p-5", staff ? "border-accent/40" : "border-border")}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{displayName(m.author)}</span>
              {staff && <Badge tone="info">{t("Staff")}</Badge>}
              {m.via === "email" && <Badge>{t("by email")}</Badge>}
              <span className="ml-auto text-xs text-muted">{formatDateTime(m.createdAt, locale)}</span>
            </div>
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{m.body}</p>
            {(files.get(m.id) ?? []).length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3 text-xs">
                {(files.get(m.id) ?? []).map((f) => (
                  <li key={f.id}><a href={`/api/tickets/attachments/${f.id}`} download className="inline-flex items-center gap-1.5 rounded-theme border border-border px-2.5 py-1.5 hover:border-accent">📎 <span className="font-medium">{f.name}</span> <span className="text-muted">{size(f.size)}</span></a></li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
