import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export const cn = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ─── Button ──────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:opacity-85",
  secondary: "btn-secondary bg-transparent text-fg border border-fg/80 hover:bg-fg/5",
  ghost: "text-fg hover:bg-subtle",
  danger: "bg-danger text-white hover:opacity-90",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export const buttonClass = (variant: Variant = "primary", size: Size = "md", extra?: string) =>
  cn(
    "btn inline-flex items-center justify-center gap-2 rounded-theme font-normal whitespace-nowrap transition",
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
  return <div {...props} className={cn("card rounded-card border border-border bg-surface", className)} />;
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-1">
      <div>
        <h2 className="text-xl font-medium">{title}</h2>
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
        <h1 className="text-[2rem] leading-tight font-normal">{title}</h1>
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
      <span className="mb-1.5 block text-sm font-medium text-fg">{label}</span>
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
      <input type="checkbox" {...props} className="size-4 rounded accent-(--accent)" />
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
  running: "success",
  succeeded: "success",
  ready: "success",
  live: "success",
  creating: "warning",
  queued: "warning",
  building: "warning",
  restoring: "warning",
  deleting: "warning",
  stopped: "neutral",
  error: "danger",
  failed: "danger",
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

const DOT: Record<Tone, string> = { neutral: "bg-muted", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info" };

/** Status as a coloured dot plus label. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const tone = STATUS_TONE[status] ?? "neutral";
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium whitespace-nowrap text-body">
      <span aria-hidden className={cn("size-2 rounded-full", DOT[tone], (tone === "warning" || status === "running") && status !== "running" && "animate-pulse")} />
      {label ?? STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Read-only value in a soft box with its label above, as used on detail pages. */
export function DataField({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <p className="mb-1.5 text-sm font-medium text-muted">{label}</p>
      <div className="flex min-h-10 items-center rounded-theme bg-subtle px-3 py-2 text-sm break-all text-fg">{children}</div>
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border-strong text-sm text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-6 py-4 font-normal whitespace-nowrap first:pl-6">
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
  <td {...props} className={cn("h-11 px-6 py-2 align-middle text-fg", className)} />
);

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className="font-display mt-1 text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export function Alert({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div role="status" className={cn("rounded-theme border px-4 py-3 text-sm whitespace-pre-line", TONE[tone])}>{children}</div>;
}
