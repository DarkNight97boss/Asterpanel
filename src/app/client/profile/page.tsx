import { ActionForm, SubmitButton } from "@/components/action-form";
import { ProfileFields } from "@/components/profile-fields";
import { Card, CardHeader, Field, Input, PageHeader } from "@/components/ui";
import { getT } from "@/i18n";
import { requireUser } from "@/lib/auth";
import { changePassword, updateProfile } from "../actions";

export default async function Profile() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  return (
    <>
      <PageHeader title={t("Profile")} description={user.email} />
      <div className="space-y-6">
        <Card>
          <CardHeader title={t("Contact & billing details")} description={t("Shown on your invoices.")} />
          <div className="p-5">
            <ActionForm action={updateProfile}>
              <ProfileFields user={user} />
              <SubmitButton>{t("Save")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <CardHeader title={t("Change password")} description={t("Other devices will be signed out.")} />
          <div className="max-w-md p-5">
            <ActionForm action={changePassword}>
              <Field label={t("Current password")}>
                <Input name="currentPassword" type="password" autoComplete="current-password" required />
              </Field>
              <Field label={t("New password")} hint={t("At least 10 characters.")}>
                <Input name="newPassword" type="password" autoComplete="new-password" minLength={10} required />
              </Field>
              <SubmitButton>{t("Update password")}</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>
    </>
  );
}
