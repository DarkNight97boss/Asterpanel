import { WorkloadList } from "@/components/workload-list";

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; label?: string }> }) {
  return <WorkloadList type="app" filters={await searchParams} />;
}
