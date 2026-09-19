import Link from "next/link";
import { Brand } from "@/components/brand";
import { getT } from "@/i18n";

/** Sign-in screens: tiled dark backdrop, logo top-left, one white card. */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  return (
    <main className="app auth-backdrop relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      <div className="absolute top-10 left-10 z-10 hidden sm:block">
        <Brand variant="ink" />
      </div>
      <div className="relative z-10 w-full max-w-[26rem]">
        <div className="mb-6 text-center sm:hidden">
          <Brand variant="ink" />
        </div>
        {children}
        <p className="mt-5 text-center text-xs text-white/60">
          <Link href="/" className="hover:text-white">← {t("Back to the website")}</Link>
        </p>
      </div>
    </main>
  );
}
