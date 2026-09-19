import { WorkloadList } from "@/components/workload-list";

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  return <WorkloadList type="static" filters={await searchParams} />;
}
