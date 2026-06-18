"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";

export type Theme = "light" | "dark";

const STORAGE_KEY = "asterpanel.theme";

// Inline script run before paint (from the root layout <head>) so the .dark
// class is set before React hydrates — avoids a light/dark flash. Kept in sync
// with the logic below.
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start "light" to match the server render; the real value is resolved on
  // mount (the init script already set the class, so there's no visual flash).
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    let initial: Theme = "light";
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "light" || saved === "dark") initial = saved;
      else if (window.matchMedia("(prefers-color-scheme: dark)").matches) initial = "dark";
    } catch {
      /* localStorage unavailable */
    }
    setThemeState(initial);
    apply(initial);
  }, []);

  function setTheme(t: Theme) {
    setThemeState(t);
    apply(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  }

  return (
    <Ctx.Provider
      value={{ theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return { theme: "light", setTheme: () => {}, toggle: () => {} };
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
