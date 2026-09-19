import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono, Inter, Pathway_Extreme } from "next/font/google";
import { I18nProvider } from "@/i18n/client";
import { getSettings } from "@/lib/settings";
import { themeCss } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const pathway = Pathway_Extreme({ variable: "--font-pathway", subsets: ["latin", "latin-ext"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin", "latin-ext"], weight: ["300", "400"], style: ["normal", "italic"] });
const inter = Inter({ variable: "--font-inter", subsets: ["latin", "latin-ext"] });
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
    <html lang={general.locale} data-theme={theme.mode} className={`${geistSans.variable} ${geistMono.variable} ${pathway.variable} ${fraunces.variable} ${inter.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss(theme) }} />
      </head>
      <body className="min-h-dvh">
        <I18nProvider locale={general.locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
