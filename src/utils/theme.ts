export type ThemeMode = "dark" | "light";
export type ResolvedTheme = "dark" | "light";

export function getSystemTheme(): ResolvedTheme {
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function parseThemeMode(theme: string): ThemeMode {
  return theme === "light" ? "light" : "dark";
}
