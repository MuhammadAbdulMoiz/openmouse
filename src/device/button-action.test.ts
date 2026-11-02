import assert from "node:assert/strict";
import test from "node:test";

import type { MouseStatus } from "@openmouse/protocol/drivers/mouse-types";
import { previewButtonAction } from "./button-action.ts";

const status = (extra: object) => ({ buttonMappings: { Back: "Mute" }, ...extra }) as unknown as MouseStatus;

test("Default previews as the factory label", () => {
  const s = status({ buttonDefaults: { Back: "Back" } });
  assert.equal(previewButtonAction(s, "Back", "Default"), "Back");
  assert.equal(previewButtonAction(s, "Back", "Mute"), "Mute");
});

test("without buttonDefaults the action is kept as is", () => {
  assert.equal(previewButtonAction(status({}), "Back", "Default"), "Default");
  assert.equal(previewButtonAction(status({ buttonDefaults: {} }), "Back", "Default"), "Default");
});
