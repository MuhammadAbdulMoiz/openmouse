import type { MouseStatus } from "@openmouse/protocol/drivers/mouse-types";

/**
 * The label a pending button change should show. "Default" is a request, not an assignment: when
 * the driver publishes `buttonDefaults` (not in the published 0.49.0 type yet) the factory label
 * is shown instead.
 */
export function previewButtonAction(status: MouseStatus, button: string, action: string): string {
  const defaults = (status as unknown as { buttonDefaults?: Record<string, string> }).buttonDefaults;
  return action === "Default" ? defaults?.[button] ?? action : action;
}
