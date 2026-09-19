import type { Settings } from "../settings";

/** Structured message body: one definition renders both HTML and plain text. */
export type MailContent = {
  subject: string;
  heading: string;
  greeting?: string;
  paragraphs: string[];
  /** Label/value rows shown in a summary box. */
  details?: [string, string][];
  /** Quoted block, e.g. a ticket reply. */
  quote?: string;
  cta?: { label: string; url: string };
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const br = (s: string) => esc(s).replace(/\r?\n/g, "<br>");

function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#0b0d12" : "#ffffff";
}

export function renderMail(
  content: MailContent,
  brand: { general: Settings<"general">; theme: Settings<"theme">; origin: string },
): { html: string; text: string } {
  const { general, theme, origin } = brand;
  const name = general.companyName || general.siteName;
  const logo = theme.logoUrl && (theme.logoUrl.startsWith("/") ? origin && `${origin}${theme.logoUrl}` : theme.logoUrl);
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  const details = content.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:#f6f7f9;border-radius:8px">
${content.details
  .map(
    ([k, v]) =>
      `<tr><td style="padding:9px 16px;color:#5b6577;font-size:14px">${esc(k)}</td><td align="right" style="padding:9px 16px;font-size:14px;font-weight:600;color:#0f172a">${esc(v)}</td></tr>`,
  )
  .join("\n")}
</table>`
    : "";

  const html = `<!doctype html>
<html lang="${general.locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(content.subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f3f6;font-family:${font};color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3f6;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 20px;font-size:18px;font-weight:700;color:${theme.primary}">${
    logo ? `<img src="${esc(logo)}" alt="${esc(name)}" height="32" style="height:32px;border:0">` : esc(general.siteName)
  }</td></tr>
<tr><td style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e3e6ec">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0f172a">${esc(content.heading)}</h1>
${content.greeting ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${esc(content.greeting)}</p>` : ""}
${content.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#334155">${br(p)}</p>`).join("\n")}
${content.quote ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid ${theme.primary};background:#f6f7f9;font-size:14px;line-height:1.6;color:#334155">${br(content.quote)}</div>` : ""}
${details}
${
  content.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px"><tr><td style="border-radius:8px;background:${theme.primary}"><a href="${esc(content.cta.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:${readableOn(theme.primary)};text-decoration:none">${esc(content.cta.label)}</a></td></tr></table>`
    : ""
}
</td></tr>
<tr><td style="padding:20px 4px;font-size:12px;line-height:1.6;color:#8a94a6">${esc(name)}${
    general.companyAddress ? ` · ${esc(general.companyAddress.replace(/\s*\r?\n\s*/g, ", "))}` : ""
  }${general.supportEmail ? `<br>${esc(general.supportEmail)}` : ""}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    content.heading,
    "",
    content.greeting,
    ...content.paragraphs,
    content.quote && `\n> ${content.quote.replace(/\r?\n/g, "\n> ")}\n`,
    ...(content.details?.length ? ["", ...content.details.map(([k, v]) => `${k}: ${v}`), ""] : []),
    content.cta && `${content.cta.label}: ${content.cta.url}`,
    "",
    "--",
    name,
  ]
    .filter((l): l is string => typeof l === "string")
    .join("\n");

  return { html, text };
}
