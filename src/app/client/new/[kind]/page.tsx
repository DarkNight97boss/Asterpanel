import { notFound } from "next/navigation";
import { and, asc, eq, ne } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Button, Card, CardHeader, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAccount } from "@/lib/account";
import { isStaff } from "@/lib/auth";
import { CYCLE_SUFFIX, formatMoney, headlineCycle } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { planType } from "@/modules/provisioning/platform";
import { nodeIsOnline } from "@/platform/engine";
import { TYPE_BY_PATH, WORKLOAD_LABEL } from "@/platform/ui";
import { createFromPlan, seedPlans } from "../../platform-actions";

export default async function NewWorkload({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ plan?: string }> }) {
  const type = TYPE_BY_PATH[(await params).kind];
  if (!type) notFound();
  const { user } = await requireAccount("manage");
  const db = await getDb();
  const [t, locale, billing, products, nodes, { plan }] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("billing"),
    db.select().from(schema.products).where(and(eq(schema.products.module, "platform"), eq(schema.products.hidden, false))).orderBy(asc(schema.products.position)),
    db.select().from(schema.nodes).where(ne(schema.nodes.status, "disabled")),
    searchParams,
  ]);
  const plans = products.filter((p) => planType(p.moduleConfig) === type && headlineCycle(p.pricing));
  const regions = [...new Set(nodes.filter(nodeIsOnline).map((n) => n.region).filter(Boolean))];
  const label = WORKLOAD_LABEL[type];
  const git = type === "app" || type === "static";

  return (
    <>
      <PageHeader title={`${t("New")}: ${t(label.one)}`} description={t(label.blurb)} />
      {!plans.length ? (
        <Card>
          <div className="space-y-4 p-6 text-sm">
            <p className="text-muted">{t("There are no plans for this service yet.")}</p>
            {isStaff(user) && (
              <form action={seedPlans}>
                <Button>{t("Create the starter plans")}</Button>
              </form>
            )}
          </div>
        </Card>
      ) : (
        <ActionForm action={createFromPlan} className="max-w-3xl space-y-6">
          {!nodes.some(nodeIsOnline) && <Alert tone="warning">{t("No server is online right now: the service will be created as soon as one is available.")}</Alert>}
          <Card>
            <CardHeader title={t("1. Plan")} />
            <div className="grid gap-3 p-5 sm:grid-cols-2">
              {plans.map((p, i) => {
                const cycle = headlineCycle(p.pricing)!;
                return (
                  <label key={p.id} className="cursor-pointer rounded-theme border border-border p-4 has-checked:border-accent has-checked:bg-accent/5">
                    <span className="flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2.5 font-semibold">
                        <input type="radio" name="productId" value={p.id} defaultChecked={plan ? p.slug === plan : i === 0} className="accent-(--accent)" required />
                        {p.name}
                      </span>
                      <span className="text-sm font-semibold">
                        {p.pricing[cycle] ? `${formatMoney(p.pricing[cycle]!, billing.currency, locale)}${t(CYCLE_SUFFIX[cycle])}` : t("Free")}
                      </span>
                    </span>
                    <span className="mt-2 block text-xs text-muted">
                      {p.moduleConfig.memoryMb} MB RAM · {p.moduleConfig.cpus} vCPU · {p.moduleConfig.diskGb} GB
                    </span>
                  </label>
                );
              })}
              <input type="hidden" name="cycle" value="monthly" />
            </div>
          </Card>

          <Card>
            <CardHeader title={t("2. Details")} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t("Name")} hint={t("Only for you: shown in the dashboard.")}><Input name="name" required minLength={2} maxLength={60} placeholder={type === "wordpress" ? "My blog" : type === "database" ? "orders-db" : "my-project"} /></Field>
              <Field label={t("Region")}>
                <Select name="region">
                  <option value="">{t("Automatic")}</option>
                  {regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
              </Field>

              {type === "wordpress" && (
                <>
                  <Field label={t("WordPress admin email")}><Input name="adminEmail" type="email" defaultValue={user.email} required /></Field>
                  <Field label={t("WordPress admin username")}><Input name="adminUser" defaultValue="admin" required /></Field>
                  <Field label={t("PHP version")}>
                    <Select name="phpVersion" defaultValue="8.3">{["8.4", "8.3", "8.2", "8.1"].map((v) => <option key={v}>{v}</option>)}</Select>
                  </Field>
                </>
              )}
              {type === "database" && (
                <>
                  <Field label={t("Engine")}>
                    <Select name="engine" defaultValue="mysql">
                      <option value="mysql">MySQL (MariaDB)</option>
                      <option value="postgres">PostgreSQL</option>
                      <option value="redis">Redis</option>
                    </Select>
                  </Field>
                  <Field label={t("Version")} hint={t("Leave empty for the latest stable.")}><Input name="version" placeholder="17" /></Field>
                </>
              )}
              {git && (
                <>
                  <Field label={t("Git repository (HTTPS)")} className="sm:col-span-2"><Input name="repoUrl" type="url" placeholder="https://github.com/you/project.git" required /></Field>
                  <Field label={t("Branch")}><Input name="branch" defaultValue="main" required /></Field>
                  <Field label={t("Access token")} hint={t("Only for private repositories. Stored encrypted.")}><Input name="accessToken" type="password" autoComplete="off" /></Field>
                  {type === "static" ? (
                    <>
                      <Field label={t("Build command")} hint={t("Runs in a Node.js 22 container. Leave empty for plain HTML.")}><Input name="buildCommand" placeholder="npm ci && npm run build" /></Field>
                      <Field label={t("Output directory")}><Input name="outputDir" placeholder="dist" /></Field>
                    </>
                  ) : (
                    <>
                      <Field label={t("Port")} hint={t("The port your app listens on. Also provided as $PORT.")}><Input name="port" type="number" defaultValue={8080} /></Field>
                      <Field label={t("Environment variables")} hint="KEY=value" className="sm:col-span-2"><Textarea name="env" rows={4} className="font-mono" spellCheck={false} /></Field>
                      <p className="text-xs text-muted sm:col-span-2">{t("Node.js, Python, Go, PHP, Ruby and static sites are recognised automatically; anything else needs a Dockerfile in the repository root. The app must listen on $PORT.")}</p>
                    </>
                  )}
                </>
              )}
            </div>
          </Card>
          <Field label={t("Discount code")} className="max-w-xs"><Input name="coupon" maxLength={40} autoComplete="off" className="uppercase" /></Field>
          <SubmitButton size="lg">{t("Create")}</SubmitButton>
        </ActionForm>
      )}
    </>
  );
}
