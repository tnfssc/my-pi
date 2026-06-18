import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const STORE_DIR = join(AGENT_DIR, "profiles");
const STORE_PATH = join(STORE_DIR, "profiles.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const BACKUP_DIR = join(STORE_DIR, "settings-backups");

const REPLACE_FIELDS = ["packages", "extensions", "skills", "prompts", "themes"] as const;
const MERGE_FIELDS = [
  "theme",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledModels",
  "compaction",
  "shellPath",
  "steeringMode",
  "hideThinkingBlock",
] as const;
const MANAGED_FIELDS = [...REPLACE_FIELDS, ...MERGE_FIELDS] as const;

type ManagedField = (typeof MANAGED_FIELDS)[number];
type JsonObject = Record<string, unknown>;

type Profile = {
  description: string;
  settings: Partial<Record<ManagedField, unknown>>;
  createdAt: string;
  updatedAt: string;
};

type Store = {
  version: 1;
  active?: string;
  profiles: Record<string, Profile>;
};

function nowStamp(): string {
  return new Date().toISOString();
}

function safeName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error(`Invalid profile name "${name}". Use letters, numbers, dot, underscore, dash; max 64 chars.`);
  }
  return trimmed;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.keys(val as JsonObject).sort().reduce((out: JsonObject, key) => {
        out[key] = (val as JsonObject)[key];
        return out;
      }, {});
    }
    return val;
  });
}

async function readJson(path: string, fallback: JsonObject): Promise<JsonObject> {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function loadSettings(): Promise<JsonObject> {
  return readJson(SETTINGS_PATH, {});
}

async function loadStore(): Promise<Store> {
  const raw = await readJson(STORE_PATH, { version: 1, profiles: {} });
  return {
    version: 1,
    active: typeof raw.active === "string" ? raw.active : undefined,
    profiles: raw.profiles && typeof raw.profiles === "object" ? raw.profiles as Record<string, Profile> : {},
  };
}

async function saveStore(store: Store): Promise<void> {
  await writeJsonAtomic(STORE_PATH, store);
}

function snapshot(settings: JsonObject): Partial<Record<ManagedField, unknown>> {
  const out: Partial<Record<ManagedField, unknown>> = {};
  for (const key of MANAGED_FIELDS) {
    if (settings[key] !== undefined) out[key] = structuredClone(settings[key]);
  }
  return out;
}

function applyProfile(current: JsonObject, profileSettings: Partial<Record<ManagedField, unknown>>): JsonObject {
  const next: JsonObject = structuredClone(current);
  for (const key of REPLACE_FIELDS) {
    if (profileSettings[key] !== undefined) next[key] = structuredClone(profileSettings[key]);
    else delete next[key];
  }
  for (const key of MERGE_FIELDS) {
    if (profileSettings[key] !== undefined) next[key] = structuredClone(profileSettings[key]);
  }
  return next;
}

async function ensureBootstrapped(): Promise<Store> {
  const store = await loadStore();
  if (Object.keys(store.profiles).length > 0) return store;
  const settings = await loadSettings();
  const ts = nowStamp();
  store.active = "default";
  store.profiles.default = {
    description: "Snapshot of settings.json when profile-manager first loaded",
    settings: snapshot(settings),
    createdAt: ts,
    updatedAt: ts,
  };
  await saveStore(store);
  return store;
}

async function backupSettings(reason: string): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(BACKUP_DIR, `${stamp}-${reason}.json`);
  const settings = await loadSettings();
  await writeJsonAtomic(dest, settings);
  return dest;
}

function formatSettings(settings: Partial<Record<ManagedField, unknown>>): string {
  const lines: string[] = [];
  for (const key of MANAGED_FIELDS) {
    if (settings[key] === undefined) continue;
    const value = settings[key];
    if (Array.isArray(value)) lines.push(`  ${key}: [${value.length}]`);
    else if (value && typeof value === "object") lines.push(`  ${key}: {…}`);
    else lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n") || "  (no managed fields)";
}

function describeDiffValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}] ${JSON.stringify(value)}`;
  return JSON.stringify(value);
}

async function profileDiff(name: string): Promise<string[]> {
  const store = await ensureBootstrapped();
  const profile = store.profiles[name];
  if (!profile) throw new Error(`Profile "${name}" not found.`);
  const currentSnapshot = snapshot(await loadSettings());
  const target = profile.settings;
  const diffs: string[] = [];
  for (const key of MANAGED_FIELDS) {
    if (stableStringify(currentSnapshot[key]) !== stableStringify(target[key])) {
      diffs.push(`${key}: ${describeDiffValue(currentSnapshot[key])} -> ${describeDiffValue(target[key])}`);
    }
  }
  return diffs;
}

async function switchProfileByName(name: string, ctx: any): Promise<void> {
  const safe = safeName(name);
  const store = await ensureBootstrapped();
  const profile = store.profiles[safe];
  if (!profile) throw new Error(`Profile "${safe}" not found.`);
  const diffs = await profileDiff(safe);
  if (diffs.length === 0) {
    store.active = safe;
    await saveStore(store);
    ctx.ui.notify(`Profile "${safe}" already matches current settings. Reloading…`, "info");
    await ctx.reload();
    return;
  }
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(`Switch to profile "${safe}"?`, `Will update settings.json and reload.\n\n${diffs.join("\n")}`);
    if (!ok) {
      ctx.ui.notify("Switch cancelled.", "info");
      return;
    }
  }
  const backup = await backupSettings(`before-${safe}`);
  const next = applyProfile(await loadSettings(), profile.settings);
  await writeJsonAtomic(SETTINGS_PATH, next);
  store.active = safe;
  await saveStore(store);
  ctx.ui.notify(`Switched to "${safe}". Backup: ${backup}. Reloading…`, "info");
  await ctx.reload();
}

async function registerProfileShortcutCommands(pi: ExtensionAPI): Promise<void> {
  const store = await ensureBootstrapped();
  for (const [name, profile] of Object.entries(store.profiles)) {
    const commandName = `profile-${name}`;
    pi.registerCommand(commandName, {
      description: `Switch to profile: ${profile.description}`,
      handler: async (_args, ctx) => {
        try {
          await switchProfileByName(name, ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }
}

async function applyDefaultModelFromSettings(pi: ExtensionAPI, ctx: any): Promise<void> {
  const settings = await loadSettings();
  const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
  const modelId = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
  if (provider && modelId) {
    const current = ctx.model;
    if (current?.provider !== provider || current?.id !== modelId) {
      const model = ctx.modelRegistry.find(provider, modelId);
      if (model) {
        const success = await pi.setModel(model);
        if (!success) ctx.ui.notify(`Profile model ${provider}/${modelId} exists but no API key is available.`, "warning");
      } else {
        ctx.ui.notify(`Profile model ${provider}/${modelId} not found after reload.`, "warning");
      }
    }
  }

  const thinking = settings.defaultThinkingLevel;
  if (typeof thinking === "string") {
    pi.setThinkingLevel(thinking as any);
  }
}

export default function profileManager(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureBootstrapped();
      await registerProfileShortcutCommands(pi);
      await applyDefaultModelFromSettings(pi, ctx);
    } catch (error) {
      ctx.ui.notify(`profile-manager bootstrap failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.registerCommand("profiles", {
    description: "Manage named Pi settings profiles",
    getArgumentCompletions: (prefix) => {
      const raw = prefix ?? "";
      const hasTrailingSpace = /\s$/.test(raw);
      const parts = raw.trim().split(/\s+/).filter(Boolean);
      const subcommands = [
        { value: "list", label: "list", description: "List profiles" },
        { value: "show", label: "show", description: "Show active/profile details" },
        { value: "save", label: "save", description: "Save current settings as profile" },
        { value: "switch", label: "switch", description: "Switch profile and reload" },
        { value: "diff", label: "diff", description: "Show switch diff" },
        { value: "path", label: "path", description: "Show store path" },
      ];

      if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
        const needle = parts[0]?.toLowerCase() ?? "";
        return subcommands.filter((item) => item.value.startsWith(needle));
      }

      const command = parts[0]?.toLowerCase();
      if (["switch", "set", "show", "diff"].includes(command) && (parts.length === 1 || (parts.length === 2 && !hasTrailingSpace))) {
        try {
          const storePath = STORE_PATH;
          if (!existsSync(storePath)) return null;
          const rawStore = JSON.parse(readFileSync(storePath, "utf8")) as Store;
          const needle = parts.length === 2 ? parts[1].toLowerCase() : "";
          return Object.keys(rawStore.profiles ?? {})
            .filter((name) => name.toLowerCase().startsWith(needle))
            .map((name) => ({ value: `${command} ${name}`, label: name, description: rawStore.profiles[name]?.description }));
        } catch {
          return null;
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = parts[0] ?? "show";
      try {
        const store = await ensureBootstrapped();

        if (cmd === "path") {
          ctx.ui.notify(`Profiles: ${STORE_PATH}\nSettings: ${SETTINGS_PATH}`, "info");
          return;
        }

        if (cmd === "list") {
          const lines = Object.entries(store.profiles).map(([name, profile]) => {
            const marker = name === store.active ? "*" : " ";
            return `${marker} ${name} — ${profile.description}`;
          });
          ctx.ui.notify(lines.length ? lines.join("\n") : "No profiles.", "info");
          return;
        }

        if (cmd === "show") {
          const name = parts[1] ?? store.active ?? "default";
          const profile = store.profiles[name];
          if (!profile) throw new Error(`Profile "${name}" not found.`);
          ctx.ui.notify([
            `Profile: ${name}${name === store.active ? " (active)" : ""}`,
            `Description: ${profile.description}`,
            `Updated: ${profile.updatedAt}`,
            formatSettings(profile.settings),
          ].join("\n"), "info");
          return;
        }

        if (cmd === "save") {
          const name = safeName(parts[1] ?? "");
          const description = parts.slice(2).join(" ") || `Saved profile: ${name}`;
          const existing = store.profiles[name];
          if (existing && ctx.hasUI) {
            const ok = await ctx.ui.confirm(`Overwrite profile "${name}"?`, "Current managed settings will replace the saved profile.");
            if (!ok) {
              ctx.ui.notify("Save cancelled.", "info");
              return;
            }
          }
          const ts = nowStamp();
          store.profiles[name] = {
            description,
            settings: snapshot(await loadSettings()),
            createdAt: existing?.createdAt ?? ts,
            updatedAt: ts,
          };
          await saveStore(store);
          ctx.ui.notify(`Saved profile "${name}" to ${STORE_PATH}`, "info");
          return;
        }

        if (cmd === "diff") {
          const name = safeName(parts[1] ?? "");
          const diffs = await profileDiff(name);
          ctx.ui.notify(diffs.length ? diffs.join("\n") : `Profile "${name}" matches current settings.`, "info");
          return;
        }

        if (cmd === "switch" || cmd === "set") {
          await switchProfileByName(parts[1] ?? "", ctx);
          return;
        }

        ctx.ui.notify("Usage: /profiles [list|show [name]|save <name> [desc]|diff <name>|switch <name>|path]", "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
