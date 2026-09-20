import type { WpBlueprint } from "@/db/schema";

/** Pure: checks a blueprint. Slugs are wordpress.org ones; everything ends up in wp-cli arguments on a node, so nothing else is let through. */

export class BlueprintError extends Error {}

export const MAX_BLUEPRINT_PLUGINS = 20;
export const PERMALINKS = ["/%postname%/", "/%year%/%monthnum%/%postname%/", "/%category%/%postname%/", "/archives/%post_id%"] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TIMEZONE = /^(UTC|[A-Z][A-Za-z_]{1,20}\/[A-Z][A-Za-z_+-]{1,30}(\/[A-Z][A-Za-z_]{1,30})?)$/;

/** Accepts slugs or wordpress.org URLs, one per line or comma separated. */
export function parseSlugs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const slug = raw.trim().toLowerCase().replace(/^https?:\/\/(?:[a-z-]+\.)?wordpress\.org\/(?:plugins|themes)\//, "").replace(/\/.*$/, "");
    if (!slug) continue;
    if (!SLUG.test(slug)) throw new BlueprintError(`“${raw.slice(0, 40)}” is not a wordpress.org slug`);
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export function cleanBlueprint(input: { plugins: string[]; theme?: string; permalinks?: string; timezone?: string; hideFromSearch?: boolean }): WpBlueprint {
  const plugins = [...new Set(input.plugins)];
  if (plugins.length > MAX_BLUEPRINT_PLUGINS) throw new BlueprintError(`A blueprint holds at most ${MAX_BLUEPRINT_PLUGINS} plugins`);
  if (plugins.some((p) => !SLUG.test(p))) throw new BlueprintError("Plugins are wordpress.org slugs");
  const theme = input.theme?.trim().toLowerCase() || undefined;
  if (theme && !SLUG.test(theme)) throw new BlueprintError("The theme is a wordpress.org slug");
  const permalinks = input.permalinks || undefined;
  if (permalinks && !(PERMALINKS as readonly string[]).includes(permalinks)) throw new BlueprintError("Choose one of the listed permalink structures");
  const timezone = input.timezone?.trim() || undefined;
  if (timezone && !TIMEZONE.test(timezone)) throw new BlueprintError("The time zone looks like Europe/Rome");
  return { plugins, theme, permalinks, timezone, hideFromSearch: input.hideFromSearch || undefined };
}
