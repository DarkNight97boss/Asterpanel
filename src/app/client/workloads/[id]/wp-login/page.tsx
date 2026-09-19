import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Card } from "@/components/ui";
import { getT } from "@/i18n";
import { requireWorkload } from "@/platform/access";
import { takeWpLoginUrl } from "@/platform/engine";

export const metadata = { title: "WordPress admin", referrer: "no-referrer" };

/** Waits for the one-time link, then sends the browser to it. The link is wiped from our side as it is shown. */
export default async function WpLogin({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ job?: string }> }) {
  const { workload: w } = await requireWorkload((await params).id);
  const jobId = (await searchParams).job ?? "";
  const t = await getT();
  const result = /^[0-9a-f-]{36}$/i.test(jobId) ? await takeWpLoginUrl(w.id, jobId) : { state: "gone" as const };

  return (
    <Card className="mx-auto mt-10 max-w-lg p-8 text-center">
      {result.state === "waiting" && (
        <>
          <AutoRefresh active intervalMs={1500} />
          <span className="mb-4 inline-block size-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
          <p>{t("Signing you in to WordPress…")}</p>
        </>
      )}
      {result.state === "ready" && (
        <>
          <meta httpEquiv="refresh" content={`0;url=${result.url}`} />
          <p className="mb-4">{t("Your one-time link is ready. It works once and expires in a minute.")}</p>
          <a href={result.url} rel="noreferrer" className="font-medium text-link underline">{t("Open WordPress admin")}</a>
        </>
      )}
      {(result.state === "failed" || result.state === "gone") && (
        <>
          <Alert tone="warning">{result.state === "failed" ? t("The login link could not be created. Is the site running?") : t("This link was already used. Ask for a new one.")}</Alert>
          <p className="mt-4"><Link href={`/client/workloads/${w.id}`} className="text-link">← {w.name}</Link></p>
        </>
      )}
    </Card>
  );
}
