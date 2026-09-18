import { Brand } from "@/components/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-subtle px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Brand />
        </div>
        {children}
      </div>
    </main>
  );
}
