import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "hh-dashboard-theme";

function getInitial(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem(KEY) as Theme | null;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitial);

  useEffect(() => {
    apply(theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return {
    theme,
    isDark: theme === "dark",
    setTheme: setThemeState,
    toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
  };
}
