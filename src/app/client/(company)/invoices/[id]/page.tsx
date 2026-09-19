import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { InvoiceView } from "@/components/invoice-view";
import { Alert, buttonClass, Card } from "@/components/ui";
import { getT } from "@/i18n";
import { loadInvoice } from "@/lib/invoices";
import { requireAccount } from "@/lib/account";
import { enabledGateways } from "@/modules/gateways";
import { payInvoice } from "@/app/client/actions";

export default async function ClientInvoice({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ paid?: string }>;
}) {
  const { account: user } = await requireAccount("billing");
  const invoice = await loadInvoice((await params).id);
  if (!invoice || invoice.companyId !== user.id) notFound();
  const [t, gateways, { paid }] = await Promise.all([getT(), enabledGateways(), searchParams]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        {paid && invoice.status === "unpaid" && <Alert tone="info">{t("Thanks! Your payment is being confirmed — this page updates within a minute.")}</Alert>}
        <InvoiceView invoice={invoice} />
      </div>
      <div className="space-y-4">
        <a href={`/api/invoices/${invoice.id}/pdf`} target="_blank" rel="noopener" className={buttonClass("secondary", "md", "w-full")}>
          {t("Download PDF")}
        </a>
      {invoice.status === "unpaid" && (
        <Card className="h-fit p-5">
          <h2 className="mb-3 font-semibold">{t("Pay this invoice")}</h2>
          {gateways.length ? (
            <div className="space-y-3">
              {gateways.map((g) => (
                <ActionForm key={g.id} action={payInvoice}>
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <input type="hidden" name="gateway" value={g.id} />
                  <SubmitButton className="w-full" variant={g.id === "stripe" ? "primary" : "secondary"}>
                    {t(g.name)}
                  </SubmitButton>
                </ActionForm>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">{t("No payment methods are available. Please contact support.")}</p>
          )}
        </Card>
      )}
      </div>
    </div>
  );
}
