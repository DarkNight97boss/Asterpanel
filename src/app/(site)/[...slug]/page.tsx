import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RenderBlocks } from "@/cms/render";
import { getPublishedPage } from "@/lib/pages";

type Props = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getPublishedPage((await params).slug.join("/"));
  return page ? { title: page.seoTitle || page.title, description: page.seoDescription || undefined } : {};
}

export default async function CmsPage({ params }: Props) {
  const page = await getPublishedPage((await params).slug.join("/"));
  if (!page) notFound();
  return <RenderBlocks blocks={page.blocks} />;
}
