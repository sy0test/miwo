export interface SettingsMenuItem {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
}

const USER_SETTINGS_KEYS = new Set(["ui", "billing", "language", "loginConfig", "logoutConfig"]);

export function getVisibleSettingsItems<T extends SettingsMenuItem>(role: string, items: readonly T[]): readonly T[] {
  if (role === "admin") return items.filter((item) => item.key !== "dbConfig");
  return items.filter((item) => USER_SETTINGS_KEYS.has(item.key));
}
