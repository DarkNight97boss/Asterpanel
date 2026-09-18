import { Fragment, type ReactNode } from "react";
import { safeHref } from "./blocks";

/**
 * Deliberately small Markdown → React renderer. It builds elements instead of
 * HTML strings, so editor content can never inject markup or scripts.
 * Supported: headings, paragraphs, bullet/numbered lists, blockquotes, rules,
 * **bold**, *italic*, `code` and [links](url).
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      const external = /^https?:/i.test(href);
      return (
        <a key={i} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {link[1]}
        </a>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;

  const collect = (test: (l: string) => boolean) => {
    const buf: string[] = [];
    while (i < lines.length && test(lines[i])) buf.push(lines[i++]);
    return buf;
  };

  while (i < lines.length) {
    const line = lines[i];
    const key = out.length;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);

    if (!line.trim()) {
      i++;
    } else if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 5)}` as "h2" | "h3" | "h4" | "h5";
      out.push(<Tag key={key}>{inline(heading[2])}</Tag>);
      i++;
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      out.push(<hr key={key} />);
      i++;
    } else if (/^\s*[-*]\s+/.test(line)) {
      const rows = collect((l) => /^\s*[-*]\s+/.test(l));
      out.push(<ul key={key}>{rows.map((r, n) => <li key={n}>{inline(r.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>);
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const rows = collect((l) => /^\s*\d+[.)]\s+/.test(l));
      out.push(<ol key={key}>{rows.map((r, n) => <li key={n}>{inline(r.replace(/^\s*\d+[.)]\s+/, ""))}</li>)}</ol>);
    } else if (/^>\s?/.test(line)) {
      const rows = collect((l) => /^>\s?/.test(l));
      out.push(<blockquote key={key}>{inline(rows.map((r) => r.replace(/^>\s?/, "")).join(" "))}</blockquote>);
    } else {
      const rows = collect((l) => !!l.trim() && !/^(#{1,4}\s|>\s?|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(l));
      if (!rows.length) rows.push(lines[i++]); // never stall on an unclassified line
      out.push(<p key={key}>{inline(rows.join(" "))}</p>);
    }
  }

  return <div className="prose">{out}</div>;
}
