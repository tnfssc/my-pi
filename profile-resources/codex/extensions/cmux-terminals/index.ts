import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Action = "start" | "read" | "search" | "write_stdin" | "list" | "close";
type Placement = "tab" | "right" | "down";

interface Params {
  action: Action;
  name?: string;
  terminal_id?: string;
  command?: string;
  cwd?: string;
  title?: string;
  focus?: boolean;
  lines?: number;
  scrollback?: boolean;
  input?: string;
  query?: string;
  regex?: boolean;
  ignore_case?: boolean;
  context?: number;
  max_matches?: number;
}

interface TerminalRecord {
  id: string;
  name?: string;
  workspace: string;
  surface: string;
  pane?: string;
  command: string;
  cwd: string;
  title?: string;
  placement: Placement;
  createdAt: number;
  status?: "running" | "stale";
  lastReadAt?: number;
  staleAt?: number;
  lastError?: string;
}

interface Store { version: 1; sessionId: string; updatedAt: number; terminals: Record<string, TerminalRecord> }
interface ExecResult { stdout: string; stderr: string; code: number; killed?: boolean }

const TOOL_NAME = "cmux_terminal";
let startQueue: Promise<unknown> = Promise.resolve();
const DEFAULT_LINES = 200;
const DEFAULT_SEARCH_LINES = 2000;
const MAX_LINES = 10000;
const DEFAULT_MAX_MATCHES = 50;
const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 750;
const ENABLED_PROFILE = "codex";
const ACTIVE_WORK_MAX_TERMINALS = 5;
const ACTIVE_WORK_PREVIEW_LINES = 12;
const ACTIVE_WORK_PREVIEW_CHARS = 1200;
const ACTIVE_WORK_PREVIEW_LINE_CHARS = 220;
const ACTIVE_WORK_TOTAL_CHARS = 6000;
const ACTIVE_WORK_READ_TIMEOUT_MS = 1200;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sessionId(ctx: ExtensionContext): string {
  try { return ctx.sessionManager.getSessionId(); } catch { return "default"; }
}
function readProfiles(): { active?: string; profiles?: Record<string, { settings?: Record<string, unknown> }> } | undefined {
  try { return JSON.parse(readFileSync(join(getAgentDir(), "profiles", "profiles.json"), "utf8")); }
  catch { return undefined; }
}
function isEnabledProfile(): boolean {
  return readProfiles()?.active === ENABLED_PROFILE;
}
function statePath(ctx: ExtensionContext): string {
  const file = ctx.sessionManager.getSessionFile?.();
  if (!file) throw new Error("cmux_terminal requires a persisted Pi session for per-session state");
  return `${file}.cmux-terminals.json`;
}
function readStore(): Store {
  throw new Error("readStore requires context");
}
function readSessionStore(ctx: ExtensionContext): Store {
  try {
    const parsed = JSON.parse(readFileSync(statePath(ctx), "utf8")) as Store;
    return parsed && typeof parsed === "object" && parsed.terminals
      ? { version: 1, sessionId: parsed.sessionId || sessionId(ctx), updatedAt: parsed.updatedAt || Date.now(), terminals: parsed.terminals }
      : emptyStore(ctx);
  } catch { return emptyStore(ctx); }
}
function emptyStore(ctx: ExtensionContext): Store { return { version: 1, sessionId: sessionId(ctx), updatedAt: Date.now(), terminals: {} }; }
function writeStore(ctx: ExtensionContext, store: Store): void {
  store.updatedAt = Date.now();
  mkdirSync(dirname(statePath(ctx)), { recursive: true });
  writeFileSync(statePath(ctx), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}
function sessionTerminals(ctx: ExtensionContext): Record<string, TerminalRecord> {
  return readSessionStore(ctx).terminals;
}
function saveTerminal(ctx: ExtensionContext, record: TerminalRecord): void {
  const store = readSessionStore(ctx);
  store.terminals[record.id] = record;
  writeStore(ctx, store);
}
function updateTerminal(ctx: ExtensionContext, record: TerminalRecord): void { saveTerminal(ctx, record); }
function deleteTerminal(ctx: ExtensionContext, record: TerminalRecord): void {
  const store = readSessionStore(ctx);
  delete store.terminals[record.id];
  writeStore(ctx, store);
}
function shellEscape(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function configuredShell(): string {
  const profiles = readProfiles();
  const activeSettings = profiles?.active ? profiles.profiles?.[profiles.active]?.settings : undefined;
  const activeSection = activeSettings?.["cmux-terminal"];
  if (activeSection && typeof activeSection === "object" && !Array.isArray(activeSection)) {
    const shell = (activeSection as { shell?: unknown }).shell;
    if (typeof shell === "string" && shell.trim()) return shell.trim();
  }
  const activeShellPath = activeSettings?.shellPath;
  if (typeof activeShellPath === "string" && activeShellPath.trim()) return activeShellPath.trim();
  try {
    const parsed = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
    const section = parsed["cmux-terminal"];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      const shell = (section as { shell?: unknown }).shell;
      if (typeof shell === "string" && shell.trim()) return shell.trim();
    }
    const shellPath = parsed.shellPath;
    if (typeof shellPath === "string" && shellPath.trim()) return shellPath.trim();
  } catch {}
  return "/bin/zsh";
}
function historyIgnored(command: string): string { return ` ${command}`; }

function buildShellCommand(cwd: string, command: string): string {
  return `${historyIgnored(`cd ${shellEscape(cwd)}`)}\n${historyIgnored(command)}`;
}
function safeNumber(value: unknown, fallback: number, max = MAX_LINES): number {
  const n = typeof value === "number" ? Math.floor(value) : fallback;
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}
function parseJson<T>(text: string): T | undefined { try { return JSON.parse(text) as T; } catch { return undefined; } }

function cmuxSocketPath(): string {
  return process.env.CMUX_SOCKET_PATH || "/tmp/cmux.sock";
}

async function cmuxSocket(command: string, timeoutMs = CMUX_TIMEOUT_MS): Promise<string> {
  const socketPath = cmuxSocketPath();
  if (!existsSync(socketPath)) throw new Error(`cmux socket not found: ${socketPath}`);
  return new Promise((resolve, reject) => {
    let output = "";
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`cmux socket command timed out: ${command.split("\n", 1)[0]}`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${command}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("end", () => {
      clearTimeout(timer);
      const trimmed = output.trimEnd();
      if (/^(ERR|ERROR)\b/i.test(trimmed)) reject(new Error(trimmed));
      else resolve(trimmed);
    });
  });
}

async function cmuxJson(method: string, params: Record<string, unknown> = {}, timeoutMs = CMUX_TIMEOUT_MS): Promise<any> {
  const socketPath = cmuxSocketPath();
  if (!existsSync(socketPath)) throw new Error(`cmux socket not found: ${socketPath}`);
  return new Promise((resolve, reject) => {
    let output = "";
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`cmux json command timed out: ${method}`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const resp = JSON.parse(output.trim());
        if (resp.ok === false) reject(new Error(resp.error?.message ?? JSON.stringify(resp.error ?? resp)));
        else resolve(resp.result);
      } catch (error) { reject(error); }
    });
  });
}

function currentWorkspace(): string {
  const workspace = process.env.CMUX_WORKSPACE_ID?.trim() || process.env.CMUX_TAB_ID?.trim();
  if (!workspace) throw new Error("cmux_terminal must run inside a cmux workspace (CMUX_WORKSPACE_ID missing)");
  return workspace;
}

function currentSurface(): string | undefined {
  return process.env.CMUX_SURFACE_ID?.trim() || process.env.CMUX_PANEL_ID?.trim();
}

function parseSocketListIds(output: string): string[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\*?\s*\d+:\s+([A-Fa-f0-9-]{8,})\b/);
    return match?.[1] ? [match[1]] : [];
  });
}

function parseFocusedSocketListId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\*\s*\d+:\s+([A-Fa-f0-9-]{8,})\b/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function parseCreatedSurfaceId(output: string): string | undefined {
  const trimmed = output.trim();
  const okMatch = trimmed.match(/^OK\s+([A-Fa-f0-9-]{8,})\b/);
  if (okMatch?.[1]) return okMatch[1];
  const uuidMatch = trimmed.match(/\b([A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})\b/);
  return uuidMatch?.[1];
}

async function currentFocusedWorkspace(): Promise<string | undefined> {
  try { return (await cmuxSocket("current_workspace", 1500)).trim() || undefined; }
  catch { return undefined; }
}

async function focusedSurfaceInWorkspace(workspace?: string): Promise<string | undefined> {
  if (!workspace) return undefined;
  try { return parseFocusedSocketListId(await cmuxSocket(`list_surfaces ${workspace}`, 1500)); }
  catch { return undefined; }
}

async function selectWorkspace(workspace: string, surface?: string): Promise<void> {
  await cmuxSocket(`select_workspace ${workspace}`, 1500);
  if (surface) {
    try { await cmuxSocket(`focus_surface ${surface}`, 1500); } catch {}
  }
}

async function restoreFocus(workspace?: string, surface?: string): Promise<void> {
  if (surface) {
    try { await cmuxSocket(`focus_surface ${surface}`, 1500); return; } catch {}
  }
  if (workspace) {
    try { await cmuxSocket(`select_workspace ${workspace}`, 1500); } catch {}
  }
}

async function listSurfaceIds(workspace: string): Promise<string[]> {
  return parseSocketListIds(await cmuxSocket(`list_surfaces ${workspace}`));
}

async function waitForNewSurface(workspace: string, previousSurfaceIds: string[]): Promise<string> {
  const prevSurfaces = new Set(previousSurfaceIds);
  for (let i = 0; i < SPLIT_READY_ATTEMPTS; i++) {
    const surfaces = await listSurfaceIds(workspace);
    for (const s of surfaces) if (!prevSurfaces.has(s)) return s;
    await sleep(SPLIT_READY_DELAY_MS);
  }
  throw new Error("Created cmux terminal, but could not find the new surface");
}

async function writeInputToSurface(workspace: string, surface: string, input: string): Promise<void> {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part.length > 0) await cmuxJson("surface.send_text", { workspace_id: workspace, surface_id: surface, text: part });
    if (index < parts.length - 1) await cmuxJson("surface.send_key", { workspace_id: workspace, surface_id: surface, key: "enter" });
  }
}

async function closeSurfaceBestEffort(workspace: string, surface: string): Promise<void> {
  try { await cmuxJson("surface.close", { workspace_id: workspace, surface_id: surface }, 1500); } catch {}
}

async function readSurfaceText(workspace: string, surface: string, lines: number, scrollback: boolean): Promise<string> {
  const result = await cmuxJson("surface.read_text", { workspace_id: workspace, surface_id: surface, lines, scrollback }, 10000);
  return result?.text ?? "";
}

async function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = startQueue;
  let release!: () => void;
  startQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try { return await fn(); }
  finally { release(); }
}

function isSurfaceMissing(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /surface (?:not found|no longer exists)|terminal surface not found/i.test(msg);
}

function markStale(ctx: ExtensionContext, record: TerminalRecord, error: unknown): never {
  markStaleRecord(ctx, record, error);
  throw new Error(`cmux terminal ${record.name ?? record.id} is stale: ${record.lastError}. Start it again with action=start.`);
}

function markStaleRecord(ctx: ExtensionContext, record: TerminalRecord, error: unknown): void {
  record.status = "stale";
  record.staleAt = Date.now();
  record.lastError = error instanceof Error ? error.message : String(error);
  updateTerminal(ctx, record);
}

function resolveTerminal(ctx: ExtensionContext, params: Params): TerminalRecord {
  const terminals = sessionTerminals(ctx);
  if (params.terminal_id) {
    const found = terminals[params.terminal_id];
    if (!found) throw new Error(`No cmux terminal with id ${params.terminal_id} in this session`);
    return found;
  }
  if (params.name) {
    const matches = Object.values(terminals).filter((t) => t.name === params.name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`Multiple cmux terminals named ${params.name}; use terminal_id`);
    throw new Error(`No cmux terminal named ${params.name} in this session`);
  }
  throw new Error("Specify name or terminal_id");
}

async function start(_pi: ExtensionAPI, ctx: ExtensionContext, params: Params) {
  const command = params.command?.trim();
  if (!command) throw new Error("start requires command");
  const name = params.name?.trim();
  if (name && Object.values(sessionTerminals(ctx)).some((t) => t.name === name)) throw new Error(`cmux terminal name already exists in this session: ${name}`);
  const placement: Placement = "tab";
  const cwd = params.cwd?.trim() || ctx.cwd;
  const workspace = currentWorkspace();
  const agentSurface = currentSurface();
  const previousFocusedWorkspace = await currentFocusedWorkspace();
  const previousFocusedSurface = await focusedSurfaceInWorkspace(previousFocusedWorkspace);
  const before = await listSurfaceIds(workspace);
  await selectWorkspace(workspace, agentSurface);
  const createOutput = await cmuxSocket("new_surface --type=terminal");
  const surface = parseCreatedSurfaceId(createOutput) ?? await waitForNewSurface(workspace, before);
  if (params.focus !== true) await restoreFocus(previousFocusedWorkspace, previousFocusedSurface);
  try {
    await sleep(SURFACE_BOOT_DELAY_MS);
    await writeInputToSurface(workspace, surface, `${buildShellCommand(cwd, command)}\n`);
  } catch (error) {
    await closeSurfaceBestEffort(workspace, surface);
    throw error;
  }
  const title = (params.title?.trim() || name || command).slice(0, 48);
  const record: TerminalRecord = { id: `term_${randomUUID().slice(0, 8)}`, name, workspace, surface, command, cwd, title, placement, createdAt: Date.now(), status: "running" };
  saveTerminal(ctx, record);
  return { text: `Started ${command} in cmux terminal${name ? ` ${name}` : ""} (${record.id}, ${surface}).`, details: record };
}

async function readTerminal(_pi: ExtensionAPI, ctx: ExtensionContext, params: Params): Promise<{ text: string; details: unknown }> {
  const record = resolveTerminal(ctx, params);
  const lines = safeNumber(params.lines, DEFAULT_LINES);
  let output: string;
  try { output = await readSurfaceText(record.workspace, record.surface, lines, params.scrollback !== false); }
  catch (error) { if (isSurfaceMissing(error)) markStale(ctx, record, error); throw error; }
  record.lastReadAt = Date.now(); updateTerminal(ctx, record);
  return { text: output || "(no terminal output)", details: { ...record, lines } };
}

function searchText(text: string, params: Params): string {
  const query = params.query;
  if (!query) throw new Error("search requires query");
  const ignoreCase = params.ignore_case !== false;
  const regex = params.regex === true;
  const context = Math.max(0, Math.min(20, Math.floor(params.context ?? 0)));
  const maxMatches = safeNumber(params.max_matches, DEFAULT_MAX_MATCHES, 500);
  const lines = text.split(/\r?\n/);
  const matcher = regex
    ? new RegExp(query, ignoreCase ? "i" : "")
    : undefined;
  const isMatch = (line: string) => regex ? matcher!.test(line) : (ignoreCase ? line.toLowerCase().includes(query.toLowerCase()) : line.includes(query));
  const picked = new Set<number>(); let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isMatch(lines[i]!)) continue;
    matches++;
    if (matches > maxMatches) break;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) picked.add(j);
  }
  if (matches === 0) return `No matches for ${JSON.stringify(query)}.`;
  const out = [...picked].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`).join("\n");
  return matches > maxMatches ? `${out}\n... (${matches - maxMatches}+ more matches truncated)` : out;
}

async function searchTerminal(_pi: ExtensionAPI, ctx: ExtensionContext, params: Params): Promise<{ text: string; details: unknown }> {
  const record = resolveTerminal(ctx, params);
  const lines = safeNumber(params.lines, DEFAULT_SEARCH_LINES);
  let output: string;
  try { output = await readSurfaceText(record.workspace, record.surface, lines, true); }
  catch (error) { if (isSurfaceMissing(error)) markStale(ctx, record, error); throw error; }
  return { text: searchText(output, params), details: { ...record, lines, query: params.query } };
}

async function writeStdin(_pi: ExtensionAPI, ctx: ExtensionContext, params: Params): Promise<{ text: string; details: unknown }> {
  const record = resolveTerminal(ctx, params);
  if (typeof params.input !== "string") throw new Error("write_stdin requires input");
  try { await writeInputToSurface(record.workspace, record.surface, params.input); }
  catch (error) { if (isSurfaceMissing(error)) markStale(ctx, record, error); throw error; }
  return { text: `Wrote ${params.input.length} chars to cmux terminal ${record.name ?? record.id}.`, details: record };
}

function listTerminals(ctx: ExtensionContext): { text: string; details: unknown } {
  const records = Object.values(sessionTerminals(ctx)).sort((a, b) => a.createdAt - b.createdAt);
  if (records.length === 0) return { text: "No cmux terminals started in this Pi session.", details: { terminals: [] } };
  const text = records.map((t) => `${t.id}${t.name ? ` (${t.name})` : ""} [${t.status ?? "running"}]: ${t.command} @ ${t.surface}`).join("\n");
  return { text, details: { terminals: records } };
}

function truncateOneLine(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function truncateBlock(value: string, max: number): string {
  const trimmed = value.trimEnd();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 80)).trimEnd()}\n... <truncated ${trimmed.length - Math.max(0, max - 80)} chars>`;
}

function isPreviewFillerLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^~+$/.test(trimmed)) return true;
  if (/^[─━═\-\s]+$/.test(trimmed)) return true;
  if (/^Last login:/i.test(trimmed)) return true;
  if (trimmed === "Writer") return true;
  if (/^This system is reserved for authorized use only/i.test(trimmed)) return true;
  if (/^and the use of this system may be monitored\.?$/i.test(trimmed)) return true;
  if (/^[^\s]*\s*❯\s*cd\s+['\"]/.test(trimmed)) return true;
  if (/^[^\s]*\s*❯\s*env\s+PI_CMUX_SUBAGENT_DEPTH=1\s+pi\s+/.test(trimmed)) return true;
  return false;
}

function normalizePreview(output: string): string {
  const meaningful = output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => !isPreviewFillerLine(line))
    .map((line) => line.length > ACTIVE_WORK_PREVIEW_LINE_CHARS ? `${line.slice(0, ACTIVE_WORK_PREVIEW_LINE_CHARS - 3)}...` : line);
  if (meaningful.length === 0) return "(no meaningful terminal output)";
  return meaningful.slice(-ACTIVE_WORK_PREVIEW_LINES).join("\n");
}

async function readPreview(ctx: ExtensionContext, record: TerminalRecord): Promise<string> {
  try {
    const output = await readSurfaceText(record.workspace, record.surface, ACTIVE_WORK_PREVIEW_LINES * 4, true);
    return truncateBlock(normalizePreview(output || ""), ACTIVE_WORK_PREVIEW_CHARS);
  } catch (error) {
    if (isSurfaceMissing(error)) markStaleRecord(ctx, record, error);
    const msg = error instanceof Error ? error.message : String(error);
    return `<preview unavailable: ${truncateOneLine(msg, 180)}>`;
  }
}

function subagentStatePath(ctx: ExtensionContext): string | undefined {
  const sf = ctx.sessionManager?.getSessionFile?.();
  return sf ? `${sf}.cmux-subagents.json` : undefined;
}

function runningSubagents(ctx: ExtensionContext): Array<{ id: string; name?: string; prompt?: string; surface: string; status?: string }> {
  const path = subagentStatePath(ctx);
  if (!path || !existsSync(path)) return [];
  try {
    const store = JSON.parse(readFileSync(path, "utf8"));
    return Object.values(store.subagents ?? {}).filter((r: any) => r?.status === "running" && typeof r.surface === "string") as Array<{ id: string; name?: string; prompt?: string; surface: string; status?: string }>;
  } catch { return []; }
}

async function readSurfacePreview(surface: string): Promise<string | undefined> {
  try {
    const output = await readSurfaceText(currentWorkspace(), surface, ACTIVE_WORK_PREVIEW_LINES * 4, true);
    return truncateBlock(normalizePreview(output || ""), ACTIVE_WORK_PREVIEW_CHARS);
  } catch { return undefined; }
}

async function activeWorkStatus(ctx: ExtensionContext): Promise<string | undefined> {
  let records: TerminalRecord[];
  try { records = Object.values(sessionTerminals(ctx)).filter((t) => t.status !== "stale").sort((a, b) => a.createdAt - b.createdAt); }
  catch { records = []; }
  const subagents = runningSubagents(ctx);
  if (records.length === 0 && subagents.length === 0) return undefined;
  const lines = ["<active_work>"];
  let shown = 0;
  if (records.length > 0) {
    lines.push("Open terminals for this Pi session:");
    for (const t of records.slice(0, ACTIVE_WORK_MAX_TERMINALS)) {
      const name = t.name ? `${t.name} ` : "";
      const preview = await readPreview(ctx, t);
      if (t.status === "stale") continue;
      shown++;
      lines.push(`- ${name}(${t.id}) [tracked]: started: ${truncateOneLine(t.command)} @ ${t.surface}`);
      lines.push("  Current screen:");
      for (const previewLine of preview.split(/\r?\n/)) lines.push(`  ${previewLine}`);
    }
    if (records.length > ACTIVE_WORK_MAX_TERMINALS) lines.push(`- ... ${records.length - ACTIVE_WORK_MAX_TERMINALS} more terminals omitted`);
  }
  if (subagents.length > 0) {
    if (shown > 0) lines.push("");
    lines.push("Running subagents for this Pi session:");
    for (const s of subagents.slice(0, ACTIVE_WORK_MAX_TERMINALS)) {
      shown++;
      lines.push(`- ${s.name ?? s.id} (${s.id}) [running]: ${truncateOneLine(s.prompt ?? "")} @ ${s.surface}`);
      const preview = await readSurfacePreview(s.surface);
      if (preview) {
        lines.push("  Current screen:");
        for (const previewLine of preview.split(/\r?\n/)) lines.push(`  ${previewLine}`);
      }
    }
    if (subagents.length > ACTIVE_WORK_MAX_TERMINALS) lines.push(`- ... ${subagents.length - ACTIVE_WORK_MAX_TERMINALS} more subagents omitted`);
  }
  if (shown === 0) return undefined;
  lines.push("Use cmux_terminal or cmux_subagent list/result/read/search for details; use write_stdin/send to interact.", "</active_work>");
  return truncateBlock(lines.join("\n"), ACTIVE_WORK_TOTAL_CHARS);
}

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["start", "read", "search", "write_stdin", "list", "close"] },
    name: { type: "string", description: "Session-local terminal name." },
    terminal_id: { type: "string", description: "Terminal id returned by start/list." },
    command: { type: "string", description: "Command to start in a persistent cmux terminal." },
    cwd: { type: "string" },
    title: { type: "string" },
    focus: { type: "boolean", default: false },
    lines: { type: "number" },
    scrollback: { type: "boolean", default: true },
    input: { type: "string", description: "Raw stdin text to write. Include \\n when Enter is wanted." },
    query: { type: "string" },
    regex: { type: "boolean", default: false },
    ignore_case: { type: "boolean", default: true },
    context: { type: "number", default: 0 },
    max_matches: { type: "number", default: 50 }
  }
} as const;

export default function cmuxTerminals(pi: ExtensionAPI) {
  if (!isEnabledProfile()) return;

  pi.on("context", async (event, ctx) => {
    const status = await activeWorkStatus(ctx);
    if (!status) return undefined;
    return {
      messages: [
        ...event.messages,
        {
          role: "user",
          content: [{ type: "text", text: status }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "cmux terminal",
    description: "Start, inspect, interact with, and close persistent cmux terminal tabs for background/interactive work. Starts always create new cmux tabs.",
    promptSnippet: "Use cmux_terminal for persistent/background/interactive terminal commands; use bash for finite captured commands. Starts always create new cmux tabs.",
    promptGuidelines: [
      "Use action=start for dev servers, watchers, log tails, TUIs, REPLs, or commands the user wants kept open/visible.",
      "cmux_terminal action=start always opens a new cmux tab; do not request right/down splits.",
      "Do not use cmux_terminal for quick finite commands; use bash instead.",
      "Started terminals are automatically summarized in active_work with a small live screen preview; use read/search when you need more output.",
      "Use action=write_stdin to send raw input; include \n when Enter is wanted.",
      "Use action=close to close the cmux tab and remove the terminal from this session's tracked list.",
      "If close sees a missing surface, the stale record is still removed."
    ],
    parameters: parameters as any,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as Params;
      let result: { text: string; details: unknown };
      if (params.action === "start") result = await withStartLock(() => start(pi, ctx, params));
      else if (params.action === "read") result = await readTerminal(pi, ctx, params);
      else if (params.action === "search") result = await searchTerminal(pi, ctx, params);
      else if (params.action === "write_stdin") result = await writeStdin(pi, ctx, params);
      else if (params.action === "list") result = listTerminals(ctx);
      else if (params.action === "close") {
        const record = resolveTerminal(ctx, params);
        try { await cmuxJson("surface.close", { workspace_id: record.workspace, surface_id: record.surface }); }
        catch (error) { if (!isSurfaceMissing(error)) throw error; }
        deleteTerminal(ctx, record);
        result = { text: `Closed cmux terminal ${record.name ?? record.id}.`, details: record };
      }
      else throw new Error(`Unknown action: ${(params as { action?: string }).action}`);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    }
  });
}
