import { RecapManager } from "./manager";
import { loadConfig } from "../../config";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerRecap(pi: ExtensionAPI): void {
  let recapManager: RecapManager | undefined = undefined;

  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx).recap;
    if (!ctx.hasUI || !config) return;

    recapManager = new RecapManager(pi, config);

    pi.registerCommand("recap", {
      description: "Generate a short recap of the current session",
      handler: async () => await recapManager?.run(ctx, { force: true }),
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    recapManager?.clear(ctx);
    recapManager = undefined;
  });
}
