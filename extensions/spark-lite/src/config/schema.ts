import * as z from "zod";

import { creditsConfigSchema } from "../features/credits/config";
import { editorConfigSchema } from "../features/editor/config";
import { footerConfigSchema } from "../features/footer/config";
import { fullscreenConfigSchema } from "../features/fullscreen/config";
import { recapConfigSchema } from "../features/recap/config";

const disabled = z.literal(false);

/**
 * Each feature field is `{ ... } | false`: `false` disables the feature, an object configures
 * it, and an omitted field falls back to defaults (`{}`, enabled).
 */
export const sparkConfigSchema = z.object({
  credits: creditsConfigSchema.or(disabled).default({}),
  editor: editorConfigSchema.or(disabled).default({}),
  footer: footerConfigSchema.or(disabled).default({}),
  fullscreen: fullscreenConfigSchema.or(disabled).default({}),
  recap: recapConfigSchema.or(disabled).default({}),
});

/** Resolved config for every feature; `false` means the feature is disabled. */
export type SparkConfig = z.infer<typeof sparkConfigSchema>;
