import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { InvoiceView } from "@/components/invoice-view";
import { Button, buttonClass, Card, Field, Input } from "@/components/ui";
import { getT } from "@/i18n";
import { centsToInput } from "@/lib/format";
import { loadInvoice } from "@/lib/invoices";
import { addPayment, cancelInvoice, resendInvoiceEmail } from "../../actions";
import { requireArea } from "@/lib/auth";

export default async function AdminInvoice({ params }: { params: Promise<{ id: string }> }) {
  await requireArea("billing");
  const invoice = await loadInvoice((await params).id);
  if (!invoice) notFound();
  const t = await getT();
  const balance = invoice.total - invoice.transactions.reduce((sum, tx) => sum + tx.amount, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <InvoiceView invoice={invoice} />
      <div className="space-y-4">
        <Card className="space-y-3 p-5">
          <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noopener" className={buttonClass("secondary", "md", "w-full")}>
            {t("Download PDF")}
          </a>
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
      </div>
    </div>
  );
}
