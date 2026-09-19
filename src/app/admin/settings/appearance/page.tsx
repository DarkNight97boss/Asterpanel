import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getT } from "@/i18n";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { saveTheme } from "../../actions";

export default async function Appearance() {
  await requireAdmin();
  const [t, s] = await Promise.all([getT(), getSettings("theme")]);
  const colour = "h-10 w-full cursor-pointer rounded-theme border border-border bg-surface p-1";
  return (
    <>
      <PageHeader title={t("Appearance")} description={t("Brand your website, client area and admin.")} />
      <Card className="max-w-2xl p-5">
        <ActionForm action={saveTheme}>
          <Field label={t("Logo URL")} hint={t("Leave empty to show the site name.")}><Input name="logoUrl" defaultValue={s.logoUrl} placeholder="https://…/logo.svg" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Primary colour")}><input type="color" name="primary" defaultValue={s.primary} className={colour} /></Field>
            <Field label={t("Accent colour")}><input type="color" name="accent" defaultValue={s.accent} className={colour} /></Field>
            <Field label={t("Colour mode")}>
              <Select name="mode" defaultValue={s.mode}>
                <option value="auto">{t("Follow visitor's system")}</option>
                <option value="light">{t("Light")}</option>
                <option value="dark">{t("Dark")}</option>
              </Select>
            </Field>
            <Field label={t("Corner radius")}>
              <Select name="radius" defaultValue={s.radius}>
                <option value="none">{t("Square")}</option>
                <option value="sm">{t("Small")}</option>
                <option value="md">{t("Medium")}</option>
                <option value="lg">{t("Large")}</option>
                <option value="full">{t("Extra large")}</option>
              </Select>
            </Field>
            <Field label={t("Font")}>
              <Select name="font" defaultValue={s.font}>
                <option value="editorial">{t("Editorial (serif headings)")}</option>
                <option value="geist">Geist</option>
                <option value="system">{t("System UI")}</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </Select>
            </Field>
            <Field label={t("Footer text")}><Input name="footerText" defaultValue={s.footerText} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Announcement bar")} hint={t("Shown above the site header. Leave empty to hide.")}><Input name="announcement" defaultValue={s.announcement} maxLength={200} /></Field>
            <Field label={t("Announcement link")}><Input name="announcementHref" defaultValue={s.announcementHref} placeholder="/register" /></Field>
          </div>
          <Field label={t("Custom CSS")} hint={t("Loaded on every page after the theme.")}>
            <Textarea name="customCss" defaultValue={s.customCss} rows={6} className="font-mono" spellCheck={false} />
          </Field>
          <SubmitButton>{t("Save")}</SubmitButton>
        </ActionForm>
      </Card>
    </>
  );
}
