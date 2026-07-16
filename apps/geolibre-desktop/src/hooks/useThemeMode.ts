import { useCallback, useLayoutEffect, useState } from "react";
import { PRODUCT_PROFILE } from "../config/product-profile";

export type ThemeMode = "light" | "dark";

export function getInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  // An explicit `?theme=dark` / `?theme=light` overrides the product default on
  // load (handy for embeds); the in-app toggle still works afterwards.
  const themeParam = new URLSearchParams(window.location.search)
    .get("theme")
    ?.trim()
    .toLowerCase();
  if (themeParam === "dark" || themeParam === "light") {
    return themeParam;
  }

  return PRODUCT_PROFILE.theme;
}

export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);

  useLayoutEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  const toggleThemeMode = useCallback(() => {
    setThemeMode((currentThemeMode) =>
      currentThemeMode === "dark" ? "light" : "dark",
    );
  }, []);

  return { themeMode, toggleThemeMode };
}
