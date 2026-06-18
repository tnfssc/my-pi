import { loadConfig } from "../../config";
import { setSparkFooterData } from "../status-line";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

class EmptyFooter implements Component {
  invalidate(): void {
    // No-op
  }

  render(): string[] {
    return [];
  }
}

export function registerFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const config = loadConfig(ctx).footer;
    if (!ctx.hasUI || !config) return;

    ctx.ui.setFooter((_tui, _theme, footerData) => {
      setSparkFooterData(footerData);
      return new EmptyFooter();
    });
  });

  pi.on("session_shutdown", () => {
    setSparkFooterData(undefined);
  });
}
