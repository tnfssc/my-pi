import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const STATUS_KEY = "pi";
const ICON = "bot";
const IDLE_COLOR = "#6b7280";
const WORKING_COLOR = "#f59e0b";
const ERROR_COLOR = "#ef4444";
const SOCKET_TIMEOUT_MS = 350;
const STALE_MS = 45_000;
const HEARTBEAT_MS = 10_000;
const STATUS_DIR = join(homedir(), ".pi", "agent", "cache", "cmux-pi-status");

type PiState = "idle" | "working" | "error" | "clear";
type AgentRecord = { id: string; state: Exclude<PiState, "clear">; updatedAt: number };
type WorkspaceState = { agents: Record<string, AgentRecord> };

let lastState: PiState | undefined;
let pendingTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;

export default function cmuxPiStatusExtension(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		setPiStatus("idle");
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = setInterval(() => {
			if (lastState && lastState !== "clear") setPiStatus(lastState);
		}, HEARTBEAT_MS);
	});
	pi.on("agent_start", () => setPiStatus("working"));
	pi.on("agent_end", () => setPiStatus("idle"));
	pi.on("session_shutdown", () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		setPiStatus("clear");
	});

	pi.registerCommand("cmux-pi-status", {
		description: "Refresh or clear Pi's aggregate cmux sidebar status for this workspace",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "clear") {
				await updateCmuxAggregateStatus("clear");
				ctx.ui.notify("Cleared this Pi agent from cmux status", "info");
				return;
			}

			const state = ctx.isIdle() ? "idle" : "working";
			await updateCmuxAggregateStatus(state);
			ctx.ui.notify(`cmux Pi status refreshed: ${state}`, "info");
		},
	});
}

function setPiStatus(state: PiState) {
	lastState = state;
	if (pendingTimer) clearTimeout(pendingTimer);
	pendingTimer = setTimeout(() => {
		pendingTimer = undefined;
		const stateToSend = lastState;
		if (stateToSend) void updateCmuxAggregateStatus(stateToSend).catch(() => undefined);
	}, 25);
}

async function updateCmuxAggregateStatus(state: PiState) {
	const socketPath = process.env.CMUX_SOCKET_PATH;
	const workspaceId = process.env.CMUX_WORKSPACE_ID || process.env.CMUX_TAB_ID;
	const tabId = process.env.CMUX_TAB_ID || workspaceId;
	const agentId = process.env.CMUX_SURFACE_ID || `${process.pid}`;
	if (!socketPath || !workspaceId || !tabId) return;

	const aggregate = await updateWorkspaceState(workspaceId, agentId, state);
	const command = aggregate === "clear"
		? `clear_status ${STATUS_KEY} --tab=${tabId}`
		: `set_status ${STATUS_KEY} ${aggregate} --icon=${ICON} --color=${colorForAggregate(aggregate)} --tab=${tabId}`;
	await sendSocketLine(socketPath, `${command}\n`);
}

async function updateWorkspaceState(workspaceId: string, agentId: string, state: PiState): Promise<string> {
	const filePath = statePath(workspaceId);
	const now = Date.now();
	await mkdir(dirname(filePath), { recursive: true });
	const workspaceState = await readWorkspaceState(filePath);

	for (const [id, record] of Object.entries(workspaceState.agents)) {
		if (now - record.updatedAt > STALE_MS) delete workspaceState.agents[id];
	}

	if (state === "clear") delete workspaceState.agents[agentId];
	else workspaceState.agents[agentId] = { id: agentId, state, updatedAt: now };

	await writeWorkspaceState(filePath, workspaceState);
	return aggregateLabel(workspaceState);
}

async function readWorkspaceState(filePath: string): Promise<WorkspaceState> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<WorkspaceState>;
		return { agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents as Record<string, AgentRecord> : {} };
	} catch {
		return { agents: {} };
	}
}

async function writeWorkspaceState(filePath: string, state: WorkspaceState) {
	const tempPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(tempPath, JSON.stringify(state), "utf8");
	await rename(tempPath, filePath).catch(async () => {
		await rm(tempPath, { force: true }).catch(() => undefined);
	});
}

function aggregateLabel(state: WorkspaceState): string {
	const agents = Object.values(state.agents);
	if (agents.length === 0) return "clear";
	const errors = agents.filter((agent) => agent.state === "error").length;
	if (errors > 0) return errors === 1 ? "error" : `${errors} errors`;
	const working = agents.filter((agent) => agent.state === "working").length;
	if (working > 0) return working === 1 ? "working" : `${working} working`;
	return agents.length === 1 ? "idle" : `${agents.length} idle`;
}

function statePath(workspaceId: string): string {
	return join(STATUS_DIR, `${workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

function colorForAggregate(label: string) {
	if (label.includes("working")) return WORKING_COLOR;
	if (label.includes("error")) return ERROR_COLOR;
	return IDLE_COLOR;
}

function sendSocketLine(socketPath: string, line: string): Promise<void> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve();
		};

		socket.setTimeout(SOCKET_TIMEOUT_MS, finish);
		socket.on("connect", () => socket.end(line));
		socket.on("data", () => undefined);
		socket.on("end", finish);
		socket.on("close", finish);
		socket.on("error", finish);
	});
}
