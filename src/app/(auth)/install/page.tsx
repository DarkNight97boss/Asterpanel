import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Checkbox, Field, Input, Select } from "@/components/ui";
import { LOCALES } from "@/i18n/shared";
import { getSettings } from "@/lib/settings";
import { install } from "../actions";

export const metadata = { title: "Install" };

export default async function InstallPage() {
  if ((await getSettings("general")).installed) redirect("/");

  return (
    <Card className="p-6">
      <h1 className="text-xl font-bold">Welcome to AsterPanel</h1>
      <p className="mt-1 mb-5 text-sm text-muted">Set up your site and create the administrator account.</p>
      <ActionForm action={install}>
        {process.env.INSTALL_TOKEN && (
          <Field label="Install token" hint="Value of the INSTALL_TOKEN environment variable.">
            <Input name="installToken" type="password" required />
          </Field>
        )}
        <Field label="Site name">
          <Input name="siteName" placeholder="Acme Hosting" required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Language">
            <Select name="locale" defaultValue="en">
              {Object.entries(LOCALES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="ISO 4217 code">
            <Input name="currency" defaultValue="EUR" pattern="[A-Za-z]{3}" maxLength={3} required />
          </Field>
        </div>
        <hr className="border-border" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">
            <Input name="firstName" required />
          </Field>
          <Field label="Last name">
            <Input name="lastName" required />
          </Field>
        </div>
        <Field label="Admin email">
          <Input name="email" type="email" required />
        </Field>
        <Field label="Admin password" hint="At least 10 characters.">
          <Input name="password" type="password" autoComplete="new-password" minLength={10} required />
        </Field>
        <Checkbox name="starterContent" defaultChecked label="Create starter content (home page, sample plans, menus)" />
        <SubmitButton className="w-full">Install</SubmitButton>
      </ActionForm>
    </Card>
  );
}
