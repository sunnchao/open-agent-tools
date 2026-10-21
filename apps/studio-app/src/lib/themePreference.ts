import { storageGet, storageSet } from "./storage";

const THEME_KEY = "open-agent-tools.studio-theme";

export type ThemePreference = "system" | "light" | "dark";

export async function loadThemePreference(): Promise<ThemePreference> {
  const value = await storageGet(THEME_KEY).catch(() => null);
  return value === "light" || value === "dark" ? value : "system";
}

export async function saveThemePreference(value: ThemePreference): Promise<void> {
  await storageSet(THEME_KEY, value);
}
