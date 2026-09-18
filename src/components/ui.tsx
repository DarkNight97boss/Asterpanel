import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ─── Button ──────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:opacity-90 shadow-sm",
  secondary: "bg-surface text-fg border border-border hover:bg-subtle",
  ghost: "text-fg hover:bg-subtle",
  danger: "bg-danger text-white hover:opacity-90",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export const buttonClass = (variant: Variant = "primary", size: Size = "md", extra?: string) =>
  cn(
    "inline-flex items-center justify-center gap-2 rounded-theme font-medium whitespace-nowrap transition",
    "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
    VARIANT[variant],
    SIZE[size],
    extra,
  );

export function Button({
  variant,
  size,
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button {...props} className={buttonClass(variant, size, className)} />;
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("rounded-theme border border-border bg-surface", className)} />;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ─── Forms ───────────────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const Input = ({ className, ...props }: ComponentProps<"input">) => (
  <input {...props} className={cn("input", className)} />
);
export const Textarea = ({ className, ...props }: ComponentProps<"textarea">) => (
  <textarea {...props} className={cn("input", className)} />
);
export const Select = ({ className, ...props }: ComponentProps<"select">) => (
  <select {...props} className={cn("input", className)} />
);

export function Checkbox({ label, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className="flex items-center gap-2.5 text-sm">
      <input type="checkbox" {...props} className="size-4 rounded accent-(--primary)" />
      <span>{label}</span>
    </label>
  );
}

// ─── Data display ────────────────────────────────────────────────────────────

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "text-muted bg-subtle border-border",
  success: "text-success bg-success/10 border-success/25",
  warning: "text-warning bg-warning/10 border-warning/25",
  danger: "text-danger bg-danger/10 border-danger/25",
  info: "text-info bg-info/10 border-info/25",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  active: "success",
  paid: "success",
  published: "success",
  answered: "success",
  pending: "warning",
  unpaid: "warning",
  customer_reply: "warning",
  open: "info",
  draft: "neutral",
  suspended: "danger",
  fraud: "danger",
  terminated: "neutral",
  cancelled: "neutral",
  closed: "neutral",
  refunded: "neutral",
};

export const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paid: "Paid",
  published: "Published",
  answered: "Answered",
  pending: "Pending",
  unpaid: "Unpaid",
  customer_reply: "Customer reply",
  open: "Open",
  draft: "Draft",
  suspended: "Suspended",
  fraud: "Fraud",
  terminated: "Terminated",
  cancelled: "Cancelled",
  closed: "Closed",
  refunded: "Refunded",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{label ?? STATUS_LABEL[status] ?? status}</Badge>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-5 py-3 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ className, ...props }: ComponentProps<"td">) => (
  <td {...props} className={cn("px-5 py-3 align-middle", className)} />
);

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export function Alert({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div role="status" className={cn("rounded-theme border px-4 py-3 text-sm whitespace-pre-line", TONE[tone])}>{children}</div>;
}
