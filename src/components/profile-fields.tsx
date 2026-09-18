import { getT } from "@/i18n";
import type { SessionUser } from "@/lib/auth";
import { Field, Input } from "./ui";

/** Contact + billing address inputs, shared by client profile and admin client editor. */
export async function ProfileFields({ user }: { user: SessionUser }) {
  const t = await getT();
  const f = (name: keyof SessionUser, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <Field label={t(label)}>
      <Input name={name} defaultValue={String(user[name] ?? "")} {...props} />
    </Field>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {f("firstName", "First name", { required: true })}
      {f("lastName", "Last name", { required: true })}
      {f("company", "Company")}
      {f("vatId", "VAT ID")}
      {f("phone", "Phone", { type: "tel" })}
      {f("address", "Address")}
      {f("city", "City")}
      {f("zip", "ZIP / Postal code")}
      {f("state", "State / Province")}
      {f("country", "Country")}
    </div>
  );
}
