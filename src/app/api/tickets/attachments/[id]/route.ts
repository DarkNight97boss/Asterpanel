import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { getUser } from "@/lib/auth";
import { listAccounts, roleCan } from "@/lib/roles";
import { staffCan } from "@/lib/staff";

export const dynamic = "force-dynamic";

/** A ticket attachment, for the people on the ticket and support staff. Always a download, never rendered: the file came from outside. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  const { id } = await params;
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const [row] = await db.select({ file: schema.ticketAttachments, clientId: schema.tickets.clientId, companyId: schema.tickets.companyId }).from(schema.ticketAttachments).innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketAttachments.ticketId)).where(eq(schema.ticketAttachments.id, id));
  const mine = row && (row.clientId === user.id || (await listAccounts(user)).some((a) => a.id === row.companyId && roleCan(a.role, "support")));
  if (!row || (!mine && !staffCan(user, "support"))) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(row.file.data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.file.name)}`,
      "Content-Length": String(row.file.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
    },
  });
}
