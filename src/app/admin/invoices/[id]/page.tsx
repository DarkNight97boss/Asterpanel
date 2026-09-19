import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { InvoiceView } from "@/components/invoice-view";
import { Button, buttonClass, Card, Field, Input, StatusBadge } from "@/components/ui";
import { getT } from "@/i18n";
import { centsToInput } from "@/lib/format";
import { loadInvoice } from "@/lib/invoices";
import { addPayment, cancelInvoice, creditInvoice, resendInvoiceEmail, sendInvoiceToSdi } from "../../actions";

const SDI_LABEL: Record<string, string> = { sent: "Sent, outcome pending", delivered: "Delivered", not_delivered: "Not delivered (available in the tax drawer)", rejected: "Rejected by the SDI", error: "Sending failed" };
const SDI_TONE: Record<string, string> = { sent: "creating", delivered: "active", not_delivered: "creating", rejected: "error", error: "error" };
import { requireArea } from "@/lib/auth";
import { getSettings } from "@/lib/settings";

export default async function AdminInvoice({ params }: { params: Promise<{ id: string }> }) {
  await requireArea("billing");
  const invoice = await loadInvoice((await params).id);
  if (!invoice) notFound();
  const [t, einvoice, sdi] = await Promise.all([getT(), getSettings("einvoice"), getSettings("sdi")]);
  const balance = invoice.total - invoice.transactions.reduce((sum, tx) => sum + tx.amount, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <InvoiceView invoice={invoice} />
      <div className="space-y-4">
        <Card className="space-y-3 p-5">
          <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noopener" className={buttonClass("secondary", "md", "w-full")}>
            {t("Download PDF")}
          </a>
          {einvoice.enabled && (
            <a href={`/api/invoices/${invoice.id}/xml`} className={buttonClass("secondary", "md", "w-full")}>
              {t("Download XML (FatturaPA)")}
            </a>
          )}
          {einvoice.enabled && sdi.provider && invoice.status !== "unpaid" && invoice.status !== "draft" && invoice.status !== "cancelled" && (
            <div className="rounded-theme border border-border p-3 text-sm">
              <p className="mb-2 flex items-center justify-between gap-2 font-medium">SDI <StatusBadge status={SDI_TONE[invoice.sdiStatus] ?? "stopped"} label={t(SDI_LABEL[invoice.sdiStatus] ?? "Not sent")} /></p>
              {invoice.sdiMessage && <p className="mb-2 text-xs break-words text-muted">{invoice.sdiMessage}</p>}
              <ActionForm action={sendInvoiceToSdi}>
                <input type="hidden" name="invoiceId" value={invoice.id} />
                {invoice.sdiStatus === "sent" || invoice.sdiStatus === "delivered" || invoice.sdiStatus === "not_delivered" ? <input type="hidden" name="refresh" value="1" /> : null}
                <SubmitButton variant="secondary" className="w-full">{invoice.sdiStatus === "" ? t("Send to the SDI") : invoice.sdiStatus === "rejected" || invoice.sdiStatus === "error" ? t("Send again") : t("Check the outcome")}</SubmitButton>
              </ActionForm>
            </div>
          )}
          <ActionForm action={resendInvoiceEmail}>
            <input type="hidden" name="invoiceId" value={invoice.id} />
            <SubmitButton variant="secondary" className="w-full">{t("Email to client")}</SubmitButton>
          </ActionForm>
        </Card>
        {invoice.status === "unpaid" && (
          <>
            <Card className="p-5">
              <h2 className="mb-3 font-semibold">{t("Record a payment")}</h2>
              <ActionForm action={addPayment}>
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <Field label={t("Amount")}><Input name="amount" inputMode="decimal" defaultValue={centsToInput(Math.max(balance, 0))} required /></Field>
                <Field label={t("Reference")}><Input name="reference" placeholder={t("Bank transfer ID, note…")} /></Field>
                <SubmitButton className="w-full">{t("Add payment")}</SubmitButton>
              </ActionForm>
            </Card>
            <form action={cancelInvoice}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <Button variant="secondary" className="w-full">{t("Cancel invoice")}</Button>
            </form>
          </>
        )}
        {invoice.status === "paid" && invoice.kind === "invoice" && (
          <Card className="p-5">
            <h2 className="mb-1 font-semibold">{t("Credit note")}</h2>
            <p className="mb-3 text-xs text-muted">{t("Reverses this invoice in full with a numbered credit note. The money itself is refunded from the payment gateway.")}</p>
            <ActionForm action={creditInvoice}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <Field label={t("Reason")}><Input name="reason" maxLength={300} /></Field>
              <SubmitButton variant="secondary" className="w-full">{t("Issue credit note")}</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </div>
  );
}
