import { displayText } from "../../../i18n/index.ts";
import type { InterfaceLocale } from "../../settings/interface-preferences";

/** Select value that opens the shortcut editor instead of writing to the device. */
export const SHORTCUT_OPTION = "\u0000keyboard-shortcut";

/** `Ctrl+Shift+A`: the chosen modifiers in the driver's order, then the key. */
export function composeShortcut(allModifiers: readonly string[], chosen: ReadonlySet<string>, key: string): string {
  return [...allModifiers.filter((name) => chosen.has(name)), key].join("+");
}

/** Translate a label; a composed `Ctrl+A` is translated part by part and re-joined. */
export function shortcutDisplay(locale: InterfaceLocale, label: string): string {
  const whole = displayText(locale, label);
  if (whole !== label || !label.includes("+")) return whole;
  return label.split("+").map((part) => displayText(locale, part)).join("+");
}
