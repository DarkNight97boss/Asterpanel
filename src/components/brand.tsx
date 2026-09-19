import Link from "next/link";
import { getSettings } from "@/lib/settings";

/** Site logo (or name) as configured in Admin → Appearance. `ink` = on dark chrome. */
export async function Brand({ href = "/", className = "", variant = "paper" }: { href?: string; className?: string; variant?: "paper" | "ink" }) {
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  return (
    <Link href={href} className={`inline-flex items-center gap-2 text-xl tracking-tight ${variant === "ink" ? "text-white" : "text-fg"} ${className}`}>
      {theme.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- admin-provided URL on any host
        <img src={theme.logoUrl} alt={general.siteName} className="h-7 w-auto" />
      ) : (
        <span className="font-semibold lowercase">{general.siteName}</span>
      )}
    </Link>
  );
}
