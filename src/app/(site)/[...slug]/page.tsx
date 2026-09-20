import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RenderBlocks } from "@/cms/render";
import { HelpfulVote } from "@/components/help-widgets";
import { getT } from "@/i18n";
import { getPublishedPage } from "@/lib/pages";
import { getSettings } from "@/lib/settings";

type Props = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getPublishedPage((await params).slug.join("/"));
  return page ? { title: page.seoTitle || page.title, description: page.seoDescription || undefined } : {};
}

export default async function CmsPage({ params }: Props) {
  const page = await getPublishedPage((await params).slug.join("/"));
  if (!page) notFound();
  const { helpPrefix } = await getSettings("general");
  // Articles, not the help centre's own index page.
  const article = !!helpPrefix && page.slug.startsWith(helpPrefix) && page.slug.length > helpPrefix.length;
  const t = article ? await getT() : null;
  return (
    <>
      <RenderBlocks blocks={page.blocks} />
      {t && <HelpfulVote slug={page.slug} labels={{ question: t("Was this article helpful?"), yes: t("Yes"), no: t("No"), thanks: t("Thanks for letting us know.") }} />}
    </>
  );
}
