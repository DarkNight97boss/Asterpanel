/** First-response / next-response targets for tickets. Pure. */

export type SlaHours = { low: number; medium: number; high: number };
export const DEFAULT_SLA: SlaHours = { low: 48, medium: 24, high: 4 };

/**
 * A ticket is "on the clock" while the customer is waiting for staff. The clock
 * starts at the customer's last message and stops when staff answers.
 */
export function slaState(ticket: { status: string; priority: keyof SlaHours; lastReplyAt: Date }, sla: SlaHours, now = new Date()): { waiting: boolean; dueAt: Date | null; breached: boolean; hoursLeft: number } {
  const waiting = ticket.status === "open" || ticket.status === "customer_reply";
  if (!waiting) return { waiting, dueAt: null, breached: false, hoursLeft: 0 };
  const dueAt = new Date(ticket.lastReplyAt.getTime() + (sla[ticket.priority] ?? DEFAULT_SLA.medium) * 3_600_000);
  const hoursLeft = (dueAt.getTime() - now.getTime()) / 3_600_000;
  return { waiting, dueAt, breached: hoursLeft < 0, hoursLeft };
}
