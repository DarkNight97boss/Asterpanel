import { getLocale, getT } from "@/i18n";
import { displayName, isStaff } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import type { schema } from "@/db";
import { Badge, cn } from "./ui";

/** Columns to load for message authors — never the password hash. */
export const AUTHOR_COLUMNS = { firstName: true, lastName: true, email: true, role: true } as const;

type Message = typeof schema.ticketMessages.$inferSelect & {
  author: Pick<typeof schema.users.$inferSelect, keyof typeof AUTHOR_COLUMNS>;
};

export async function TicketThread({ messages }: { messages: Message[] }) {
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  return (
    <ol className="space-y-4">
      {messages.map((m) => {
        const staff = isStaff(m.author);
        return (
          <li key={m.id} className={cn("rounded-theme border bg-surface p-5", staff ? "border-accent/40" : "border-border")}>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{displayName(m.author)}</span>
              {staff && <Badge tone="info">{t("Staff")}</Badge>}
              <span className="ml-auto text-xs text-muted">{formatDateTime(m.createdAt, locale)}</span>
            </div>
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
