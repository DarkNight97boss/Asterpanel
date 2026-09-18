"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useT } from "@/i18n/client";
import { Alert, Button } from "./ui";

/** Every form action returns this shape; `undefined` means "nothing to report". */
export type ActionState = { error?: string; ok?: string } | undefined;
export type FormAction = (prev: ActionState, data: FormData) => Promise<ActionState>;

/** <form> bound to a server action, showing its error / success message. */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  const t = useT();
  return (
    <form action={formAction} className={className ?? "space-y-4"}>
      {state?.error && <Alert tone="danger">{t(state.error)}</Alert>}
      {state?.ok && <Alert tone="success">{t(state.ok)}</Alert>}
      {children}
    </form>
  );
}

export function SubmitButton({
  children,
  confirm,
  ...props
}: React.ComponentProps<typeof Button> & { confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      {...props}
      disabled={pending || props.disabled}
      onClick={confirm ? (e) => !window.confirm(confirm) && e.preventDefault() : props.onClick}
    >
      {pending && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </Button>
  );
}
