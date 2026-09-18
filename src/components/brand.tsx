import Link from "next/link";
import { getSettings } from "@/lib/settings";

/** Site logo (or name) as configured in Admin → Appearance. */
export async function Brand({ href = "/", className = "" }: { href?: string; className?: string }) {
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  return (
    <Link href={href} className={`inline-flex items-center gap-2 text-lg font-bold tracking-tight ${className}`}>
      {theme.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- admin-provided URL on any host
        <img src={theme.logoUrl} alt={general.siteName} className="h-8 w-auto" />
      ) : (
        <>
          <span className="grid size-8 place-items-center rounded-theme bg-primary text-sm text-primary-fg">
            {general.siteName.slice(0, 1).toUpperCase()}
          </span>
          {general.siteName}
        </>
      )}
    </Link>
  );
}
