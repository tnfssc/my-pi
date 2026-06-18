import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AgentEndMessage = {
  role?: unknown;
  content?: unknown;
};

type ExtensionContextLike = {
  cwd?: unknown;
  sessionManager?: {
    getSessionId?: () => unknown;
  };
};

const STATUS_KEY = process.env.PI_CMUX_ATTENTION_STATUS_KEY || "pi";
const SOCKET_TIMEOUT_MS = 1200;
const PROBE_TIMEOUT_MS = 2500;

function hasCmuxContext(): boolean {
  return Boolean(process.env.CMUX_WORKSPACE_ID?.trim() && process.env.CMUX_SURFACE_ID?.trim());
}

function workspaceId(): string | undefined {
  return process.env.CMUX_WORKSPACE_ID?.trim() || process.env.CMUX_TAB_ID?.trim();
}

function surfaceId(): string | undefined {
  return process.env.CMUX_SURFACE_ID?.trim() || process.env.CMUX_PANEL_ID?.trim();
}

function socketPath(): string {
  return process.env.CMUX_SOCKET_PATH || "/tmp/cmux.sock";
}

function cmuxAvailable(): boolean {
  return existsSync(socketPath());
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function sanitizeSocketArgument(value: string): string {
  return value.replace(/[\r\n|]/g, " ").replace(/ +/g, " ").trim();
}

function notificationPayload(title: string, subtitle: string, body: string): string {
  return [title, subtitle, body].map(sanitizeSocketArgument).join("|");
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("\n") || null;
}

function isInternalStatusMessage(message: string | undefined): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  return (
    /^💾\s*Memory auto-reviewed\b/i.test(trimmed) ||
    /^Saved relevant memory\.?$/i.test(trimmed)
  );
}

function lastUserVisibleAssistantMessage(event: { messages?: unknown[] }): string | undefined {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const typed = message as AgentEndMessage;
    if (typed.role !== "assistant") continue;
    const text = firstString(textFromContent(typed.content));
    if (isInternalStatusMessage(text)) continue;
    if (text) return text;
  }
  return undefined;
}

function projectNameFromCwd(cwd: string): string | undefined {
  const name = path.basename(cwd.trim());
  return name || undefined;
}

function runCommand(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function cmuxBinary(): string {
  const configured = process.env.CMUX_PI_CMUX_BIN?.trim();
  if (configured) return configured;
  for (const candidate of [
    "/opt/homebrew/bin/cmux",
    "/usr/local/bin/cmux",
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "cmux";
}

function cmuxCurrentWorkspaceId(): string | null {
  return runCommand(cmuxBinary(), ["current-workspace"]);
}

function cmuxFocusedPanelId(ws: string): string | null {
  const output = runCommand(cmuxBinary(), ["sidebar-state", "--workspace", ws]);
  if (!output) return null;
  const line = output.split("\n").find((entry) => entry.startsWith("focused_panel="));
  return line?.slice("focused_panel=".length).trim() || null;
}

function isCmuxFrontmost(): boolean {
  const bundleId = process.env.CMUX_BUNDLE_ID || "com.cmuxterm.app";
  const script = `application id ${JSON.stringify(bundleId)} is frontmost`;
  return runCommand("/usr/bin/osascript", ["-e", script]) === "true";
}

function isTargetFocusedInFrontmostCmux(ws: string, surface: string): boolean {
  // Fail open: if any probe fails, still notify. Avoid losing useful away notifications.
  if (cmuxCurrentWorkspaceId()?.toLowerCase() !== ws.toLowerCase()) return false;
  if (cmuxFocusedPanelId(ws)?.toLowerCase() !== surface.toLowerCase()) return false;
  return isCmuxFrontmost();
}

export default function cmuxAttention(pi: ExtensionAPI) {
  if (!hasCmuxContext() || !cmuxAvailable()) return;

  let cmuxUnavailable = false;

  const runCmux = (command: string): void => {
    if (cmuxUnavailable) return;
    const socket = net.createConnection(socketPath());
    const timer = setTimeout(() => {
      socket.destroy();
      cmuxUnavailable = true;
    }, SOCKET_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${command}\n`));
    socket.on("data", (chunk) => {
      if (/^(ERR|ERROR)\b/i.test(chunk.trim())) cmuxUnavailable = true;
    });
    socket.on("error", () => {
      clearTimeout(timer);
      cmuxUnavailable = true;
    });
    socket.on("end", () => clearTimeout(timer));
  };

  const clearNotifications = (): void => {
    const ws = workspaceId();
    if (!ws) return;
    runCmux(`clear_notifications --tab=${ws}`);
  };

  const setRunningStatus = (): void => {
    const ws = workspaceId();
    if (!ws) return;
    runCmux(`set_status ${STATUS_KEY} Running --icon=bolt.fill --color=#4C8DFF --tab=${ws}`);
  };

  const setIdleStatus = (): void => {
    const ws = workspaceId();
    if (!ws) return;
    runCmux(`set_status ${STATUS_KEY} Idle --icon=checkmark.circle.fill --color=#34C759 --tab=${ws}`);
  };

  const notifyCompletion = (event: { messages?: unknown[] }, ctx?: ExtensionContextLike): void => {
    const ws = workspaceId();
    const surface = surfaceId();
    if (!ws || !surface) return;
    if (isTargetFocusedInFrontmostCmux(ws, surface)) return;

    const cwd = firstString(ctx?.cwd, process.cwd()) || process.cwd();
    const projectName = projectNameFromCwd(cwd);
    const subtitle = projectName ? `Completed in ${projectName}` : "Completed";
    const assistantMessage = lastUserVisibleAssistantMessage(event);

    const body = assistantMessage || "Pi session completed";
    const payload = notificationPayload("Pi", subtitle, body.slice(0, 200));

    // Mirrors cmux generic agent stop notification for Pi. Installed cmux build
    // on this machine exposes only raw socket commands, not `cmux hooks pi`.
    runCmux(`notify_target ${ws} ${surface} ${payload}`);
  };

  pi.on("session_start", async (_event, _ctx) => {
    clearNotifications();
    setIdleStatus();
  });

  pi.on("before_agent_start", async (_event, _ctx) => {
    clearNotifications();
    setRunningStatus();
  });

  pi.on("agent_start", async () => {
    clearNotifications();
    setRunningStatus();
  });

  pi.on("agent_end", async (event, ctx) => {
    setIdleStatus();
    notifyCompletion(event, ctx as ExtensionContextLike);
  });

  pi.on("session_shutdown", async () => {
    setIdleStatus();
  });
}
