import type { Metadata } from "next";
import { RenderBlocks } from "@/cms/render";
import { EmptyState } from "@/components/ui";
import { getPublishedPage } from "@/lib/pages";

export async function generateMetadata(): Promise<Metadata> {
  const page = await getPublishedPage("");
  return {
    ...(page?.seoTitle && { title: { absolute: page.seoTitle } }),
    ...(page?.seoDescription && { description: page.seoDescription }),
  };
}

export default async function HomePage() {
  const page = await getPublishedPage("");
  if (!page) {
    return <EmptyState title="No home page yet" description="Create a page with an empty slug in Admin → Pages and publish it." />;
  }
  return <RenderBlocks blocks={page.blocks} />;
}
