import type { Settings } from "./settings";

const RADIUS = { none: "0", sm: "0.25rem", md: "0.625rem", lg: "1rem", full: "1.5rem" } as const;

const FONT = {
  geist: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  system: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "ui-serif, Georgia, Cambria, 'Times New Roman', serif",
  mono: "var(--font-geist-mono), ui-monospace, monospace",
} as const;

/** WCAG relative luminance → pick black or white text for a brand colour. */
function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0d12" : "#ffffff";
}

/** CSS injected in <head>. Every value is validated by the settings schema. */
export function themeCss(theme: Settings<"theme">): string {
  const vars = [
    `--primary:${theme.primary}`,
    `--primary-fg:${readableOn(theme.primary)}`,
    `--accent:${theme.accent}`,
    `--radius:${RADIUS[theme.radius]}`,
    `--font-body:${FONT[theme.font]}`,
  ].join(";");
  // Custom CSS is admin-authored; stripping "<" keeps it inside the <style> tag.
  return `:root{${vars}}\n${theme.customCss.replace(/</g, "")}`;
}
