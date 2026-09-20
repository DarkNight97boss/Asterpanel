import { desc } from "drizzle-orm";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Badge, ButtonLink, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, Table, Td } from "@/components/ui";
import { getDb, schema } from "@/db";
import { getLocale, getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { getSettings } from "@/lib/settings";
import { baseUrl } from "@/lib/url";
import { saveInboundMail, saveMail, sendTestEmail } from "../../actions";

export default async function MailSettings() {
  const admin = await requireAdmin();
  const db = await getDb();
  const origin = await baseUrl();
  const [t, locale, s, general, log] = await Promise.all([
    getT(),
    getLocale(),
    getSettings("mail"),
    getSettings("general"),
    db.select().from(schema.emailLog).orderBy(desc(schema.emailLog.createdAt)).limit(50),
  ]);

  return (
    <>
      <PageHeader
        title={t("Email")}
        description={t("Invoices, payment receipts, service and ticket notifications.")}
        action={<ButtonLink href="/admin/settings/mail/templates" variant="secondary">{t("Email templates")}</ButtonLink>}
      />
      {!general.siteUrl && !process.env.APP_URL && (
        <div className="mb-6 max-w-2xl">
          <Alert tone="warning">{t("Set the Site URL in Settings, otherwise links in emails will not work.")}</Alert>
        </div>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,42rem)_1fr]">
        <Card>
          <CardHeader title="SMTP" description={t("The password is encrypted at rest and never shown again.")} />
          <div className="p-5">
            <ActionForm action={saveMail}>
              <Checkbox name="enabled" defaultChecked={s.enabled} label={t("Send email notifications")} />
              <div className="grid gap-4 sm:grid-cols-[1fr_7rem_10rem]">
                <Field label={t("SMTP host")}><Input name="host" defaultValue={s.host} placeholder="smtp.example.com" /></Field>
                <Field label={t("Port")}><Input name="port" type="number" min={1} max={65535} defaultValue={s.port} /></Field>
                <Field label={t("Encryption")}>
                  <Select name="security" defaultValue={s.security}>
                    <option value="starttls">STARTTLS</option>
                    <option value="ssl">SSL / TLS</option>
                    <option value="none">{t("None")}</option>
                  </Select>
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("Username")}><Input name="username" defaultValue={s.username} autoComplete="off" /></Field>
                <Field label={t("Password")}>
                  <Input name="password" type="password" autoComplete="off" placeholder={s.password ? "••••••••  (unchanged)" : ""} />
                </Field>
                <Field label={t("Sender name")}><Input name="fromName" defaultValue={s.fromName} placeholder={general.siteName} /></Field>
                <Field label={t("Sender address")}><Input name="fromEmail" type="email" defaultValue={s.fromEmail} placeholder="billing@example.com" /></Field>
                <Field label={t("Staff notifications to")} hint={t("New tickets and client replies. Defaults to the support email.")} className="sm:col-span-2">
                  <Input name="staffEmail" type="email" defaultValue={s.staffEmail} placeholder={general.supportEmail} />
                </Field>
              </div>
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Tickets by email")} description={t("Customers answer the notification emails, or write to the support mailbox, and it lands on the ticket. Only messages from addresses of active customers (or of support staff, for replies) are accepted.")} />
          <div className="space-y-4 p-5">
            <ActionForm action={saveInboundMail}>
              <Checkbox name="inboundEnabled" defaultChecked={s.inboundEnabled} label={t("Accept tickets and replies by email")} />
              <Field label={t("Support mailbox")} className="max-w-md"><Input name="inboundAddress" type="email" defaultValue={s.inboundAddress} placeholder="support@example.com" /></Field>
              <Checkbox name="inboundPlus" defaultChecked={s.inboundPlus} label={t("The mailbox accepts plus addresses (support+anything@…): replies are matched by a signed address instead of the subject")} />
              <div className="flex flex-wrap gap-3"><SubmitButton>{t("Save")}</SubmitButton>{s.inboundToken && <SubmitButton name="rotate" value="1" variant="ghost">{t("New token")}</SubmitButton>}</div>
            </ActionForm>
            {s.inboundEnabled && s.inboundToken && (
              <div className="space-y-2 text-sm">
                <p className="text-muted">{t("Have your mail server hand each message for that mailbox to this address, as the raw message, with the token. With Postfix or Exim, a pipe like this is enough:")}</p>
                <pre className="overflow-x-auto rounded-theme border border-border bg-paper p-3 text-xs select-all">{`curl -sS --max-time 60 --data-binary @- -H "Content-Type: message/rfc822" -H "Authorization: Bearer ${s.inboundToken}" ${origin}/api/inbound/mail`}</pre>
                <p className="text-xs text-muted">{t("Mailgun routes (field body-mime) and SendGrid Inbound Parse with the raw option (field email) work too, if they can send the Authorization header.")}</p>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title={t("Send a test email")} description={t("Uses the saved settings, even when notifications are off.")} />
          <div className="p-5">
            <ActionForm action={sendTestEmail}>
              <Field label={t("Recipient")}><Input name="to" type="email" defaultValue={admin.email} required /></Field>
              <SubmitButton variant="secondary">{t("Send test")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={t("Email log")} description={t("Last 50 messages.")} />
        {log.length ? (
          <Table head={[t("Date"), t("Recipient"), t("Subject"), t("Template"), t("Status")]}>
            {log.map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap text-muted">{formatDateTime(e.createdAt, locale)}</Td>
                <Td>{e.recipient}</Td>
                <Td className="max-w-xs truncate">{e.subject}</Td>
                <Td className="font-mono text-xs">{e.template}</Td>
                <Td>
                  {e.status === "sent" ? <Badge tone="success">{t("Sent")}</Badge> : <span title={e.error}><Badge tone="danger">{t("Failed")}</Badge></span>}
                  {e.error && <span className="mt-1 block max-w-xs truncate text-xs text-muted">{e.error}</span>}
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title={t("No emails sent yet")} />
        )}
      </Card>
    </>
  );
}
