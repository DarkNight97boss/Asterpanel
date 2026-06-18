import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { I18nProvider } from "@/lib/i18n";
import { ThemeProvider, themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "AsterPanel",
  description: "Cloud-native, security-first hosting control panel",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          <I18nProvider>
            <AuthProvider>{children}</AuthProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
