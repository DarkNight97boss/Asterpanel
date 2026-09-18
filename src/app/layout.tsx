import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { I18nProvider } from "@/i18n/client";
import { getSettings } from "@/lib/settings";
import { themeCss } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

// Everything is driven by the database (settings, pages, sessions).
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const general = await getSettings("general");
  return {
    title: { default: general.siteName, template: `%s · ${general.siteName}` },
    description: general.tagline,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [general, theme] = await Promise.all([getSettings("general"), getSettings("theme")]);
  return (
    <html lang={general.locale} data-theme={theme.mode} className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss(theme) }} />
      </head>
      <body className="min-h-dvh">
        <I18nProvider locale={general.locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
