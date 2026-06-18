import net from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Action = "start" | "list" | "result" | "stop" | "send" | "close";
type Status = "running" | "done" | "failed" | "stopped" | "stale";
type Placement = "tab" | "right" | "down";
interface Params { action: Action; name?: string; subagent_id?: string; prompt?: string; cwd?: string; model?: string; thinking?: string; inherit_context?: boolean; title?: string; focus?: boolean; input?: string; include_done?: boolean; status?: Status | "completed"; }
interface SubagentRecord { id: string; name?: string; prompt: string; cwd: string; surface: string; workspace: string; placement: Placement; createdAt: number; updatedAt: number; status: Status; exitCode?: number; piSessionId?: string; sessionFile?: string; eventsPath?: string; latestActivity?: string; result?: string; resultPreview?: string; resultPath?: string; completionNotifiedAt?: number; lastError?: string; model?: string; thinking?: string; }
interface Store { version: 1; sessionId: string; updatedAt: number; subagents: Record<string, SubagentRecord> }

const TOOL_NAME = "cmux_subagent";
const ENABLED_PROFILE = "codex";
const SOCKET_TIMEOUT_MS = 5000;
const BOOT_DELAY_MS = 750;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const RESULT_INLINE_MAX = 12000;
const RESULT_PREVIEW_MAX = 3000;
const ACTIVE_WORK_MAX_SUBAGENTS = 6;
const ACTIVE_WORK_PREVIEW_LINES = 8;
const ACTIVE_WORK_PREVIEW_CHARS = 1000;

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function isEnabledProfile(): boolean {
  try {
    const profilesPath = join(getAgentDir(), "profiles", "profiles.json");
    const parsed = JSON.parse(readFileSync(profilesPath, "utf8"));
    return parsed?.active === ENABLED_PROFILE;
  } catch { return false; }
}
function extensionDir(): string { return dirname(fileURLToPath(import.meta.url)); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function trunc(value: string, max: number): string { const s = value.trim(); return s.length > max ? `${s.slice(0, max - 80).trimEnd()}\n... <truncated ${s.length - (max - 80)} chars>` : s; }
function oneLine(value: string, max = 140): string { const s = value.replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 3)}...` : s; }
function socketPath(): string { const p = process.env.CMUX_SOCKET_PATH || "/tmp/cmux.sock"; if (!existsSync(p)) throw new Error(`cmux socket not found: ${p}`); return p; }
function cmuxSocket(command: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`cmux socket command timed out: ${command.split("\n", 1)[0]}`)); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${command}\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => { clearTimeout(timer); const trimmed = data.trimEnd(); if (/^(ERR|ERROR)\b/i.test(trimmed)) reject(new Error(trimmed)); else resolve(trimmed); });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function cmuxJson(method: string, params: Record<string, unknown> = {}, timeoutMs = SOCKET_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`cmux json command timed out: ${method}`)); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      try {
        const resp = JSON.parse(data.trim());
        if (resp.ok === false) reject(new Error(resp.error?.message ?? JSON.stringify(resp.error ?? resp)));
        else resolve(resp.result);
      } catch (error) { reject(error); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function currentWorkspace(): string {
  const workspace = process.env.CMUX_WORKSPACE_ID?.trim() || process.env.CMUX_TAB_ID?.trim();
  if (!workspace) throw new Error("cmux_subagent must run inside a cmux workspace (CMUX_WORKSPACE_ID missing)");
  return workspace;
}
function currentSurface(): string | undefined { return process.env.CMUX_SURFACE_ID?.trim() || process.env.CMUX_PANEL_ID?.trim(); }
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
  return parseSocketListIds(await cmuxSocket(`list_surfaces ${workspace}`, SOCKET_TIMEOUT_MS));
}
async function waitForNewSurface(workspace: string, previousSurfaceIds: string[]): Promise<string> {
  const prevSurfaces = new Set(previousSurfaceIds);
  for (let i = 0; i < SPLIT_READY_ATTEMPTS; i++) {
    const surfaces = await listSurfaceIds(workspace);
    for (const s of surfaces) if (!prevSurfaces.has(s)) return s;
    await sleep(SPLIT_READY_DELAY_MS);
  }
  throw new Error("Created cmux subagent surface, but could not find the new surface");
}
async function newSurface(workspace: string): Promise<string> {
  await selectWorkspace(workspace, currentSurface());
  const before = await listSurfaceIds(workspace);
  const createOutput = await cmuxSocket("new_surface --type=terminal", SOCKET_TIMEOUT_MS);
  return parseCreatedSurfaceId(createOutput) ?? await waitForNewSurface(workspace, before);
}
async function sendText(workspace: string, surface: string, input: string) {
  const parts = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let i = 0; i < parts.length; i++) { if (parts[i]) await cmuxJson("surface.send_text", { workspace_id: workspace, surface_id: surface, text: parts[i] }); if (i < parts.length - 1) await cmuxJson("surface.send_key", { workspace_id: workspace, surface_id: surface, key: "enter" }); }
}
async function closeSurfaceBestEffort(workspace: string, surface: string): Promise<void> {
  try { await cmuxJson("surface.close", { workspace_id: workspace, surface_id: surface }, 1500); } catch {}
}
async function readSurfaceText(workspace: string, surface: string, lines: number, scrollback: boolean): Promise<string> {
  const result = await cmuxJson("surface.read_text", { workspace_id: workspace, surface_id: surface, lines, scrollback }, 10000);
  return result?.text ?? "";
}
function normalizeScreen(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.replace(/\s+$/g, "")).filter((l) => {
    const t = l.trim();
    return t && !/^~+$/.test(t) && !/^[─━═\-\s]+$/.test(t);
  }).filter((l) => {
    const t = l.trim();
    if (/^Last login:/i.test(t)) return false;
    if (t === "Writer") return false;
    if (/^This system is reserved for authorized use only/i.test(t)) return false;
    if (/^and the use of this system may be monitored\.?$/i.test(t)) return false;
    if (/^[^\s]*\s*❯\s*cd\s+['\"]/.test(t)) return false;
    if (/^[^\s]*\s*❯\s*env\s+PI_CMUX_SUBAGENT_DEPTH=1\s+pi\s+/.test(t)) return false;
    return true;
  });
  return trunc(lines.slice(-ACTIVE_WORK_PREVIEW_LINES).join("\n") || "(no meaningful screen output)", ACTIVE_WORK_PREVIEW_CHARS);
}
async function screenPreview(surface: string): Promise<string | undefined> {
  try { return normalizeScreen(await readSurfaceText(currentWorkspace(), surface, ACTIVE_WORK_PREVIEW_LINES * 4, true)); }
  catch { return undefined; }
}
function statePath(ctx: ExtensionContext): string { const sf = ctx.sessionManager?.getSessionFile?.(); if (!sf) throw new Error("cmux_subagent requires a persisted Pi session file"); return `${sf}.cmux-subagents.json`; }
function artifactsDir(ctx: ExtensionContext, id: string): string { return `${statePath(ctx).replace(/\.json$/, "")}/${id}`; }
function loadStore(ctx: ExtensionContext): Store { const p = statePath(ctx); if (!existsSync(p)) return { version: 1, sessionId: ctx.sessionManager.getSessionId(), updatedAt: Date.now(), subagents: {} }; return JSON.parse(readFileSync(p, "utf8")); }
function saveStore(ctx: ExtensionContext, store: Store) { store.updatedAt = Date.now(); const p = statePath(ctx); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(store, null, 2) + "\n"); }
function update(ctx: ExtensionContext, rec: SubagentRecord) { const store = loadStore(ctx); rec.updatedAt = Date.now(); store.subagents[rec.id] = rec; saveStore(ctx, store); }
function remove(ctx: ExtensionContext, rec: SubagentRecord) { const store = loadStore(ctx); delete store.subagents[rec.id]; saveStore(ctx, store); }
function resolve(ctx: ExtensionContext, p: Params): SubagentRecord { const vals = Object.values(loadStore(ctx).subagents); if (p.subagent_id) { const r = vals.find((x) => x.id === p.subagent_id); if (!r) throw new Error(`No cmux subagent with id ${p.subagent_id}`); return r; } if (p.name) { const m = vals.filter((x) => x.name === p.name); if (m.length === 1) return m[0]!; if (m.length > 1) throw new Error(`Multiple cmux subagents named ${p.name}; use subagent_id`); } throw new Error("Provide subagent_id or name"); }
function walkSessionFiles(): string[] {
  const root = join(getAgentDir(), "sessions");
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const p = join(dir, entry);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root);
  return files;
}
function parseSessionSummary(file: string): { id?: string; cwd?: string; name?: string; assistant?: string; mtime: number } | undefined {
  try {
    const mtime = statSync(file).mtimeMs;
    let id: string | undefined; let cwd: string | undefined; let name: string | undefined; let assistant: string | undefined;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "session") { id = e.id; cwd = e.cwd; }
      else if (e.type === "session_info") name = e.name;
      else if (e.type === "message" && e.message?.role === "assistant") {
        const text = textFromContent(e.message.content).trim();
        if (text) assistant = text;
      }
    }
    return { id, cwd, name, assistant, mtime };
  } catch { return undefined; }
}
function discoverSessionFile(rec: SubagentRecord): string | undefined {
  if (rec.sessionFile && existsSync(rec.sessionFile)) return rec.sessionFile;
  const targetName = rec.name ?? rec.id;
  const candidates = walkSessionFiles()
    .map((file) => ({ file, summary: parseSessionSummary(file) }))
    .filter((x): x is { file: string; summary: NonNullable<ReturnType<typeof parseSessionSummary>> } => Boolean(x.summary))
    .filter((x) => x.summary.mtime >= rec.createdAt - 5000)
    .filter((x) => x.summary.cwd === rec.cwd)
    .filter((x) => x.summary.name === targetName)
    .sort((a, b) => b.summary.mtime - a.summary.mtime);
  return candidates[0]?.file;
}
function textFromContent(content: any): string { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((c) => c?.type === "text" ? c.text ?? "" : "").join(""); }
function extractLastAssistant(file?: string): string | undefined { if (!file || !existsSync(file)) return undefined; let last = ""; for (const line of readFileSync(file, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.type === "message" && e.message?.role === "assistant") { const t = textFromContent(e.message.content).trim(); if (t) last = t; } } catch {} } return last || undefined; }

function parseEventStream(file?: string): { sessionId?: string; result?: string; latestActivity?: string; done: boolean; error?: string } {
  const out: { sessionId?: string; result?: string; latestActivity?: string; done: boolean; error?: string } = { done: false };
  if (!file || !existsSync(file)) return out;
  let currentAssistant = "";
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "session" && e.id) out.sessionId = e.id;
    else if (e.type === "agent_end") out.done = true;
    else if (e.type === "error") out.error = e.message ?? JSON.stringify(e);
    else if (e.type === "message_start" && e.message?.role === "assistant") currentAssistant = "";
    else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") currentAssistant += e.assistantMessageEvent.delta ?? "";
    else if (e.type === "message_end" && e.message?.role === "assistant") {
      const text = textFromContent(e.message.content).trim() || currentAssistant.trim();
      if (text) out.result = text;
      currentAssistant = "";
    } else if (e.type === "tool_execution_start") out.latestActivity = `started ${e.toolName}: ${JSON.stringify(e.args ?? {})}`;
    else if (e.type === "tool_execution_update" && e.partialResult?.content?.length) {
      const text = textFromContent(e.partialResult.content).trim();
      if (text) out.latestActivity = `${e.toolName}: ${text}`;
    } else if (e.type === "tool_execution_end") {
      const text = textFromContent(e.result?.content).trim();
      out.latestActivity = `finished ${e.toolName}${text ? `: ${text}` : ""}`;
    }
  }
  return out;
}

async function refreshStatusFromScreen(ctx: ExtensionContext, rec: SubagentRecord): Promise<SubagentRecord> {
  if (rec.status !== "running") return rec;
  try {
    await readSurfaceText(rec.workspace, rec.surface, 5, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/surface (?:not found|no longer exists)|terminal surface not found/i.test(msg)) { rec.status = "stale"; rec.lastError = msg; update(ctx, rec); }
  }
  return rec;
}

function notifyCompletion(ctx: ExtensionContext, rec: SubagentRecord): void {
  if (rec.completionNotifiedAt || !rec.result) return;
  const name = rec.name ?? rec.id;
  const text = [
    `cmux subagent ${name} completed.`,
    "",
    rec.resultPath ? `${rec.resultPreview}\n\nFull result: ${rec.resultPath}` : rec.result,
    rec.sessionFile ? `\nChild session: ${rec.sessionFile}` : "",
  ].join("\n").trim();
  try { ctx.sessionManager?.appendCustomMessageEntry?.("cmux-subagent-completed", text, true, { id: rec.id, name, sessionFile: rec.sessionFile, resultPath: rec.resultPath }); }
  catch {}
  rec.completionNotifiedAt = Date.now();
}
function refreshResult(ctx: ExtensionContext, rec: SubagentRecord): SubagentRecord {
  const events = parseEventStream(rec.eventsPath);
  if (events.sessionId) rec.piSessionId = events.sessionId;
  if (events.latestActivity) rec.latestActivity = trunc(events.latestActivity, 1000);
  if (events.error) { rec.status = "failed"; rec.lastError = events.error; }
  const sf = rec.sessionFile ?? discoverSessionFile(rec);
  if (sf) { rec.sessionFile = sf; const summary = parseSessionSummary(sf); if (summary?.id) rec.piSessionId = summary.id; }
  const result = events.result ?? extractLastAssistant(sf);
  if (result) {
    rec.result = result;
    rec.resultPreview = trunc(result, RESULT_PREVIEW_MAX);
    if (rec.status === "running" && events.done) rec.status = "done";
    if (result.length > RESULT_INLINE_MAX) { const dir = artifactsDir(ctx, rec.id); mkdirSync(dir, { recursive: true }); rec.resultPath = join(dir, "result.md"); writeFileSync(rec.resultPath, result); }
    if (events.done) notifyCompletion(ctx, rec);
  }
  update(ctx, rec);
  return rec;
}
function maybePromptWithContext(ctx: ExtensionContext, prompt: string, inherit?: boolean): string { if (!inherit) return prompt; const sf = ctx.sessionManager?.getSessionFile?.(); if (!sf || !existsSync(sf)) return prompt; const lines: string[] = []; for (const line of readFileSync(sf, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const e = JSON.parse(line); if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) lines.push(`${e.message.role}: ${textFromContent(e.message.content)}`); } catch {} } const parent = trunc(lines.join("\n\n"), 20000); return `<parent_context>\n${parent}\n</parent_context>\n\n${prompt}`; }
let startQueue = Promise.resolve();

function enqueueStart<T>(work: () => Promise<T>): Promise<T> {
  const next = startQueue.then(work, work);
  startQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function start(ctx: ExtensionContext, params: Params) {
  if (!params.prompt) throw new Error("start requires prompt");
  const store = loadStore(ctx); if (params.name && Object.values(store.subagents).some((x) => x.name === params.name)) throw new Error(`cmux subagent name already exists in this session: ${params.name}`);
  const id = `sub_${Math.random().toString(16).slice(2, 10)}`;
  const dir = artifactsDir(ctx, id); mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  const cwd = params.cwd ?? process.cwd(); const placement: Placement = "tab"; const workspace = currentWorkspace(); const previousFocusedWorkspace = await currentFocusedWorkspace(); const previousFocusedSurface = await focusedSurfaceInWorkspace(previousFocusedWorkspace); const surface = await newSurface(workspace); if (params.focus !== true) await restoreFocus(previousFocusedWorkspace, previousFocusedSurface); await sleep(BOOT_DELAY_MS);
  const prompt = maybePromptWithContext(ctx, params.prompt, params.inherit_context);
  const args = ["-p", "--mode", "json", "--name", params.name ?? id]; if (params.model) args.push("--model", params.model); if (params.thinking) args.push("--thinking", params.thinking); args.push(prompt);
  const pretty = join(extensionDir(), "pretty-json-events.mjs");
  const command = `env PI_CMUX_SUBAGENT_DEPTH=1 pi ${args.map(shellQuote).join(" ")} | tee ${shellQuote(eventsPath)} | node ${shellQuote(pretty)}`;
  try { await sendText(workspace, surface, ` cd ${shellQuote(cwd)}\n ${command}\n`); }
  catch (error) { await closeSurfaceBestEffort(workspace, surface); throw error; }
  const rec: SubagentRecord = { id, name: params.name, prompt: params.prompt, cwd, surface, placement, createdAt: Date.now(), updatedAt: Date.now(), status: "running", workspace, eventsPath, model: params.model, thinking: params.thinking };
  update(ctx, rec);
  return { text: `Started cmux subagent ${params.name ?? id} (${id}).`, details: rec };
}
async function list(ctx: ExtensionContext, params: Params) { const store = loadStore(ctx); const recs = []; for (const r of Object.values(store.subagents).sort((a,b)=>a.createdAt-b.createdAt)) recs.push(refreshResult(ctx, await refreshStatusFromScreen(ctx, r))); const shown = params.include_done ? recs : recs.filter((r) => r.status === "running"); if (!shown.length) return { text: params.include_done ? "No cmux subagents in this Pi session." : "No running cmux subagents. Use include_done=true to show completed/stopped/failed records.", details: { subagents: shown, allCount: recs.length } }; return { text: shown.map((r)=>`${r.id}${r.name ? ` (${r.name})` : ""} [${r.status}]: ${oneLine(r.prompt)}${r.latestActivity ? `\n  activity: ${oneLine(r.latestActivity, 240)}` : ""}${r.resultPreview ? `\n  result: ${oneLine(r.resultPreview, 240)}` : ""}${r.eventsPath ? `\n  events: ${r.eventsPath}` : ""}${r.sessionFile ? `\n  session: ${r.sessionFile}` : ""}${r.piSessionId ? `\n  session_id: ${r.piSessionId}` : ""}`).join("\n"), details: { subagents: shown, allCount: recs.length } }; }
async function result(ctx: ExtensionContext, params: Params) { const rec = refreshResult(ctx, await refreshStatusFromScreen(ctx, resolve(ctx, params))); if (!rec.result) return { text: `No result found yet for ${rec.name ?? rec.id}.${rec.sessionFile ? ` Session: ${rec.sessionFile}` : ""}`, details: rec }; if (rec.resultPath) return { text: `${rec.resultPreview}\n\nFull result: ${rec.resultPath}\nChild session: ${rec.sessionFile ?? "unknown"}`, details: rec }; return { text: `${rec.result}\n\nChild session: ${rec.sessionFile ?? "unknown"}`, details: rec }; }
async function stop(ctx: ExtensionContext, params: Params) { const rec = resolve(ctx, params); try { await cmuxJson("surface.send_key", { workspace_id: rec.workspace, surface_id: rec.surface, key: "ctrl-c" }, 1500); } catch { await sendText(rec.workspace, rec.surface, "\u0003"); } rec.status = "stopped"; update(ctx, rec); return { text: `Stopped cmux subagent ${rec.name ?? rec.id}.`, details: rec }; }
async function send(ctx: ExtensionContext, params: Params) { const rec = resolve(ctx, params); if (!params.input) throw new Error("send requires input"); await sendText(rec.workspace, rec.surface, params.input.endsWith("\n") ? params.input : `${params.input}\n`); return { text: `Sent input to cmux subagent ${rec.name ?? rec.id}.`, details: rec }; }
async function closeOne(ctx: ExtensionContext, rec: SubagentRecord): Promise<void> { try { await cmuxJson("surface.close", { workspace_id: rec.workspace, surface_id: rec.surface }); } catch (error) { const msg = error instanceof Error ? error.message : String(error); if (!/surface (?:not found|no longer exists)|terminal surface not found/i.test(msg)) throw error; } remove(ctx, rec); }
async function close(ctx: ExtensionContext, params: Params) { if (params.status && !params.name && !params.subagent_id) { const wanted = params.status === "completed" ? new Set(["done", "failed", "stopped", "stale"]) : new Set([params.status]); const recs = Object.values(loadStore(ctx).subagents).filter((r) => wanted.has(r.status)); for (const rec of recs) await closeOne(ctx, rec); return { text: `Closed ${recs.length} cmux subagent record(s) with status ${params.status}.`, details: { closed: recs } }; } const rec = resolve(ctx, params); await closeOne(ctx, rec); return { text: `Closed cmux subagent ${rec.name ?? rec.id}.`, details: rec }; }
const parameters = { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["start", "list", "result", "stop", "send", "close"] }, name: { type: "string" }, subagent_id: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" }, model: { type: "string" }, thinking: { type: "string" }, inherit_context: { type: "boolean" }, title: { type: "string" }, focus: { type: "boolean", default: false }, input: { type: "string" }, include_done: { type: "boolean", default: false }, status: { type: "string", enum: ["running", "done", "failed", "stopped", "stale", "completed"] } } } as const;
export default function cmuxSubagents(pi: ExtensionAPI) { if (!isEnabledProfile() || process.env.PI_CMUX_SUBAGENT_DEPTH === "1") return; pi.registerTool({ name: TOOL_NAME, label: "cmux subagent", description: "Start visible Pi subagents in new cmux tabs, track live JSON-event progress, return final results, stop/send steering input, or close child cmux tabs.", promptSnippet: "Use cmux_subagent for autonomous visible child Pi agents. Starts always create new cmux tabs. Child progress streams from Pi JSON events; final results come from the JSON event stream with the child session transcript as fallback/audit path.", promptGuidelines: ["Use action=start for autonomous child tasks that can run in parallel while you continue other work.", "cmux_subagent action=start always opens a new cmux tab; do not request right/down splits.", "Subagents are task-oriented, not terminal-shaped: prefer list/result/stop/send/close over reading raw terminal output.", "Use action=list for running subagents; pass include_done=true only when you need completed/stopped/failed records.", "Use action=result to fetch a completed child result plus events/session paths for audit.", "Use action=stop when the child is going wrong or no longer needed; stop preserves partial events/results.", "Use action=send for best-effort steering of a visible child Pi terminal.", "Use action=close to close the child cmux tab and remove it from this session's tracked subagent list.", "Use close with status=completed to close/remove completed, failed, stopped, and stale child records."], parameters, async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) { const params = rawParams as Params; let out; if (params.action === "start") out = await enqueueStart(() => start(ctx, params)); else if (params.action === "list") out = await list(ctx, params); else if (params.action === "result") out = await result(ctx, params); else if (params.action === "stop") out = await stop(ctx, params); else if (params.action === "send") out = await send(ctx, params); else if (params.action === "close") out = await close(ctx, params); else throw new Error(`Unknown action: ${params.action}`); return { content: [{ type: "text", text: out.text }], details: out.details }; } }); }
