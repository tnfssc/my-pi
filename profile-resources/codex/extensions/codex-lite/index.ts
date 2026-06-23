import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createBashToolDefinition, getAgentDir, getLanguageFromPath, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const binDir = join(extensionDir, "bin");
const enabledProfile = "codex";
const configFileName = "codex-lite.json";
type ServiceTierMode = "normal" | "fast" | "flex";

interface CodexLiteConfig {
  serviceTier: ServiceTierMode;
}

interface BashCallArgs {
  command?: string;
  timeout?: number;
}

const defaultConfig: CodexLiteConfig = { serviceTier: "normal" };

function isEnabledProfile(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(getAgentDir(), "profiles", "profiles.json"), "utf8")) as { active?: unknown };
    return parsed.active === enabledProfile;
  } catch {
    return false;
  }
}

function setPathEnabled(enabled: boolean): void {
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter((part) => part && part !== binDir);
  process.env.PATH = enabled ? [binDir, ...parts].join(":") : parts.join(":");
}

function configPath(): string {
  return join(getAgentDir(), configFileName);
}

function readConfig(): CodexLiteConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<CodexLiteConfig>;
    return parsed.serviceTier === "fast" || parsed.serviceTier === "flex" || parsed.serviceTier === "normal"
      ? { serviceTier: parsed.serviceTier }
      : defaultConfig;
  } catch {
    return defaultConfig;
  }
}

function writeConfig(config: CodexLiteConfig): void {
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function nextServiceTier(mode: ServiceTierMode): ServiceTierMode {
  if (mode === "normal") return "fast";
  return "normal";
}

function serviceTierRequestValue(mode: ServiceTierMode): "priority" | "flex" | undefined {
  if (mode === "fast") return "priority";
  if (mode === "flex") return "flex";
  return undefined;
}

function serviceTierLabel(mode: ServiceTierMode): string {
  if (mode === "fast") return "fast";
  if (mode === "flex") return "flex";
  return "normal";
}

function unquoteShellToken(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === "'" || quote === '"') && trimmed[trimmed.length - 1] === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function firstShellToken(value: string): string | undefined {
  const trimmed = value.trimStart();
  if (!trimmed) return undefined;
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/, 1)[0];
}

function parseHeredocHead(line: string): { delimiter: string } | undefined {
  const match = line.match(/<<-?\s*(['\"]?)([A-Za-z0-9_][A-Za-z0-9_-]*)\1\s*$/);
  if (!match) return undefined;
  return { delimiter: match[2] };
}

function parseWriteFilePath(head: string): string | undefined {
  const match = head.match(/^\s*write_file\s+(.+?)\s+<<-?\s*(['\"]?)[A-Za-z0-9_][A-Za-z0-9_-]*\2\s*$/);
  if (!match) return undefined;
  return firstShellToken(unquoteShellToken(match[1]));
}

function highlightPatch(body: string, theme: { fg(role: string, text: string): string }): string[] {
  return body.split("\n").map((line) => {
    if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
    if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
    if (line.startsWith("@@")) return theme.fg("syntaxFunction", line);
    if (line.startsWith("***")) return theme.fg("accent", line);
    return theme.fg("toolOutput", line);
  });
}

function highlightedCodexCommand(command: string, theme: { fg(role: string, text: string): string; bold(text: string): string }): string {
  const lines = command.split("\n");
  const rendered: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const head = lines[i] ?? "";
    const heredoc = parseHeredocHead(head);
    if (!heredoc) {
      rendered.push(...highlightCode(head, "bash"));
      continue;
    }

    let endIndex = i + 1;
    while (endIndex < lines.length && lines[endIndex]?.trim() !== heredoc.delimiter) {
      endIndex++;
    }

    const body = lines.slice(i + 1, endIndex).join("\n");
    const toolName = firstShellToken(head);
    rendered.push(...highlightCode(head, "bash"));
    if (body) {
      rendered.push(...(toolName === "apply_patch"
        ? highlightPatch(body, theme)
        : toolName === "write_file"
          ? highlightCode(body, getLanguageFromPath(parseWriteFilePath(head) ?? "") ?? "")
          : highlightCode(body, "bash")));
    }
    if (endIndex < lines.length) {
      rendered.push(theme.fg("syntaxPunctuation", lines[endIndex] ?? ""));
      i = endIndex;
    }
  }

  return rendered.join("\n");
}

function registerBashSyntaxHighlighting(pi: ExtensionAPI): void {
  const originalBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...originalBash,
    renderCall(args: BashCallArgs, theme, context) {
      const base = originalBash.renderCall?.(args, theme, context);
      if (!isEnabledProfile()) return base ?? new Text("", 0, 0);

      const text = base instanceof Text ? base : context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const command = typeof args.command === "string" ? args.command : "";
      const timeoutSuffix = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
      text.setText(`${theme.fg("toolTitle", theme.bold("$ "))}${highlightedCodexCommand(command, theme)}${timeoutSuffix}`);
      return text;
    },
  });
}

function statusText(_enabled: boolean, _theme: { fg(role: string, text: string): string }): string | undefined {
  return undefined;
}

function applyProfileToolPolicy(pi: ExtensionAPI, enabled: boolean): void {
  if (!enabled) return;
  const activeTools = pi.getActiveTools();
  const nextTools = activeTools.filter((tool) => tool !== "edit" && tool !== "write");
  if (nextTools.length !== activeTools.length) {
    pi.setActiveTools(nextTools);
  }
}

function codexLitePrompt(): string {
  return [
    "Codex-compatible shell patching:",
    "- `apply_patch`, `write_file`, and `imagegen` are available on PATH for shell commands.",
    "- For file edits, prefer `bash` with a single-quoted heredoc:",
    "  `apply_patch <<'PATCH'`",
    "  `*** Begin Patch`",
    "  `*** Update File: path/from/workdir`",
    "  `@@`",
    "  `-old`",
    "  `+new`",
    "  `*** End Patch`",
    "  `PATCH`",
    "- Patch paths should be relative to the command workdir unless an absolute path is intentional.",
    "- If patch fails, read the target file and retry with tighter context.",
    "- For new files or complete rewrites, use `write_file` with a single-quoted heredoc:",
    "  `write_file path/from/workdir <<'EOF'`",
    "  `full file contents`",
    "  `EOF`",
    "- `write_file` overwrites the target file and creates parent directories.",
    "",
    "Codex-compatible image generation:",
    "- Use `imagegen` from `bash` to generate/edit images through Codex image generation.",
    "- It accepts one JSON argument or JSON on stdin.",
    "- Generate example: `imagegen '{\"prompt\":\"small red robot icon\"}'`",
    "- Edit example: `imagegen '{\"action\":\"edit\",\"prompt\":\"make background transparent\",\"images\":[\"input.png\"]}'`",
    "- It saves PNGs under workspace root `.pi/openai-codex-images/` and updates `.pi/openai-codex-images/latest.png`.",
    "- Report saved file paths from the command output. Do not embed base64 in replies.",
  ].join("\n");
}

export default function codexLite(pi: ExtensionAPI) {
  registerBashSyntaxHighlighting(pi);
  setPathEnabled(isEnabledProfile());

  pi.registerCommand("codex-fast", {
    description: "Toggle Codex service tier: normal ↔ fast",
    getArgumentCompletions: (prefix) => ["normal", "fast", "flex", "status"]
      .filter((item) => item.startsWith(prefix.trim().toLowerCase()))
      .map((value) => ({ label: value, value })),
    handler: async (args, ctx) => {
      if (!isEnabledProfile()) {
        ctx.ui.notify("codex-fast is only active in codex profile.", "warning");
        return;
      }

      const arg = args.trim().toLowerCase();
      const current = readConfig();
      if (arg === "flex") {
        ctx.ui.notify("Codex rejected flex mode: Unsupported service_tier: flex", "warning");
        return;
      }

      const serviceTier = arg === "normal" || arg === "fast"
        ? arg
        : arg === "status"
          ? current.serviceTier
          : nextServiceTier(current.serviceTier);

      if (arg !== "status") writeConfig({ serviceTier });
      if (ctx.hasUI) ctx.ui.setStatus("codex-lite", statusText(true, ctx.ui.theme));
      ctx.ui.notify(`Codex service tier: ${serviceTierLabel(serviceTier)}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const enabled = isEnabledProfile();
    setPathEnabled(enabled);
    applyProfileToolPolicy(pi, enabled);
    if (ctx.hasUI) {
      ctx.ui.setStatus("codex-lite", statusText(enabled, ctx.ui.theme));
    }
  });

  pi.on("model_select", (_event, ctx) => {
    const enabled = isEnabledProfile();
    setPathEnabled(enabled);
    applyProfileToolPolicy(pi, enabled);
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("codex-lite", statusText(enabled, ctx.ui.theme));
  });

  pi.on("before_agent_start", (_event) => {
    const enabled = isEnabledProfile();
    setPathEnabled(enabled);
    applyProfileToolPolicy(pi, enabled);
    if (!enabled) return undefined;
    return { systemPrompt: `${_event.systemPrompt}\n\n${codexLitePrompt()}` };
  });

  pi.on("before_provider_request", (event) => {
    let payload = event.payload;
    if (isEnabledProfile() && payload && typeof payload === "object") {
      const serviceTier = serviceTierRequestValue(readConfig().serviceTier);
      payload = { ...(payload as Record<string, unknown>) };
      if (serviceTier) {
        (payload as Record<string, unknown>).service_tier = serviceTier;
      } else {
        delete (payload as Record<string, unknown>).service_tier;
      }
    }

    const capturePath = process.env.CODEX_LITE_CAPTURE_PROVIDER_PAYLOAD;
    if (capturePath) writeFileSync(capturePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return payload;
  });
}
