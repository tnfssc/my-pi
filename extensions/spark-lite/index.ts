import { autoCollectEvents } from "./src/events";
import { registerCredits } from "./src/features/credits";
import { registerEditor } from "./src/features/editor";
import { registerFooter } from "./src/features/footer";
import { registerFullscreen } from "./src/features/fullscreen";
import { registerRecap } from "./src/features/recap";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * spark-lite is a local, vendored subset of pi-spark.
 * Kept: editor, footer, fullscreen, credits, manual /recap.
 * Removed: presets, pi tool, web tool, automatic idle recap.
 */
export default function (pi: ExtensionAPI) {
  const events = autoCollectEvents(pi);

  registerCredits(pi);
  registerEditor(pi, events);
  registerFooter(pi);
  registerFullscreen(pi);
  registerRecap(pi);
}
