import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { sparkConfigSchema } from "./schema";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SparkConfig } from "./schema";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** All features disabled; used as the fallback when `spark.json` fails validation. */
const DISABLED_CONFIG: SparkConfig = Object.freeze({
  credits: false,
  editor: false,
  footer: false,
  fullscreen: false,
  pi: false,
  presets: false,
  recap: false,
  web: false,
});

const cache = new Map<string, SparkConfig>();

/** Load and validate spark.json once per session lifecycle; later calls return the cached result. */
export function loadConfig(ctx: ExtensionContext, fileName: string = "spark.json"): SparkConfig {
  const key = `${ctx.cwd}\u0000${fileName}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const rawConfig = loadMergedJson(getConfigPaths(ctx.cwd, fileName)) ?? {};
  const result = sparkConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    ctx.ui.notify(`Invalid spark config: ${message}`, "error");

    const config = DISABLED_CONFIG;
    cache.set(key, config);

    return config;
  }

  const config = result.data;
  cache.set(key, config);

  return config;
}

function getConfigPaths(cwd: string, fileName: string): [globalPath: string, projectPath: string] {
  return [join(getAgentDir(), fileName), join(cwd, ".pi", fileName)];
}

function loadMergedJson(paths: string[]): JsonObject | undefined {
  let merged: JsonObject | undefined;
  paths.forEach((path) => {
    const value = readJsonFile(path);
    if (value === undefined) return;

    merged = mergeConfig(merged, value);
  });

  return merged;
}

function readJsonFile(path: string): JsonObject | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch {
    return undefined;
  }
}

function mergeConfig(base: JsonObject | undefined, override: JsonObject): JsonObject {
  if (base === undefined) return override;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;

  const result: Record<string, JsonValue> = { ...base };
  Object.entries(override).forEach(([key, overrideValue]) => {
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = { ...baseValue, ...overrideValue };
    } else {
      result[key] = overrideValue;
    }
  });

  return result;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
