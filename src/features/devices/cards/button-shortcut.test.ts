import assert from "node:assert/strict";
import test from "node:test";

import { ensureLocale } from "../../../i18n/index.ts";
import { composeShortcut, shortcutDisplay, SHORTCUT_OPTION } from "./button-shortcut.ts";

test("composeShortcut orders modifiers like the driver and ignores click order", () => {
  const mods = ["Ctrl", "Shift"];
  assert.equal(composeShortcut(mods, new Set(["Shift", "Ctrl"]), "A"), "Ctrl+Shift+A");
  assert.equal(composeShortcut(mods, new Set(["Shift"]), "F5"), "Shift+F5");
  assert.equal(composeShortcut(mods, new Set(), "Enter"), "Enter");
});

test("the shortcut sentinel can never be a device action", () => {
  assert.notEqual(SHORTCUT_OPTION, "Default");
  assert.equal(SHORTCUT_OPTION.includes("+"), false);
});

test("shortcutDisplay translates each part and leaves symbols alone", async () => {
  assert.equal(shortcutDisplay("en", "Ctrl+Shift+A"), "Ctrl+Shift+A");
  await ensureLocale("de");
  assert.equal(shortcutDisplay("de", "Ctrl+Shift+A"), "Strg+Umschalt+A");
  assert.equal(shortcutDisplay("de", "Shift+Page up"), "Umschalt+Bild auf");
});
