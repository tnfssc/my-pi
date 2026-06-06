import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "codex-usage.json");
const FRESH_MS = 60_000;
const PROMPT_MAX_AGE_MS = 15 * 60_000;
const BACKGROUND_REFRESH_TIMEOUT_MS = 6_000;
const COMMAND_REFRESH_TIMEOUT_MS = 10_000;

type RateWindow = {
	usedPercent?: number;
	windowDurationMins?: number;
	resetsAt?: number;
};

type RateLimit = {
	limitId?: string;
	limitName?: string | null;
	primary?: RateWindow;
	secondary?: RateWindow;
	planType?: string | null;
};

type Cache = {
	updatedAt: number;
	summary: string;
	promptText: string;
	statusText: string;
	raw?: unknown;
	error?: string;
};

let cache = readCache();
let refreshInFlight: Promise<Cache | undefined> | undefined;
let lastRefreshAttemptAt = 0;

export default function codexUsagePrompt(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		publishStatus(ctx);
		refreshInBackground(ctx, "startup");
	});


	pi.registerCommand("codex-usage", {
		description: "Show cached OpenAI Codex 5-hour and weekly usage; optionally refresh with /codex-usage refresh",
		handler: async (args, ctx) => {
			const shouldRefresh = args.trim() === "refresh" || !cache;
			if (shouldRefresh) {
				ctx.ui.notify("Refreshing Codex usage...", "info");
				await refresh(ctx, COMMAND_REFRESH_TIMEOUT_MS);
			}
			if (cache) {
				ctx.ui.notify(`${cache.summary}\nUpdated ${formatAge(Date.now() - cache.updatedAt)} ago`, cache.error ? "warning" : "info");
			} else {
				ctx.ui.notify("Codex usage unavailable", "warning");
			}
		},
	});
}

function refreshInBackground(ctx: ExtensionContext, reason: string) {
	const now = Date.now();
	if (refreshInFlight) return;
	if (cache && now - cache.updatedAt < FRESH_MS) return;
	if (now - lastRefreshAttemptAt < FRESH_MS) return;
	lastRefreshAttemptAt = now;

	refreshInFlight = refresh(ctx, BACKGROUND_REFRESH_TIMEOUT_MS)
		.catch((error) => {
			const message = formatError(error);
			cache = cache ? { ...cache, error: message } : undefined;
			return cache;
		})
		.finally(() => {
			refreshInFlight = undefined;
		});
	void refreshInFlight;
}

async function refresh(ctx: ExtensionContext, timeoutMs: number): Promise<Cache | undefined> {
	try {
		const raw = await fetchCodexRateLimits(timeoutMs);
		const next = buildCache(raw);
		cache = next;
		writeCache(next);
		publishStatus(ctx);
		return next;
	} catch (error) {
		const message = formatError(error);
		if (cache) {
			cache = { ...cache, error: message };
			publishStatus(ctx);
		}
		return cache;
	}
}

function publishStatus(ctx: ExtensionContext) {
	if (!cache) return;
	const stale = Date.now() - cache.updatedAt > PROMPT_MAX_AGE_MS ? " stale" : "";
	ctx.ui.setStatus("codex-usage", `${cache.statusText}${stale}`);
}

function fetchCodexRateLimits(timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", ["-s", "read-only", "-a", "untrusted", "app-server"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let settled = false;
		let stderr = "";
		const timer = setTimeout(() => finish(new Error("Codex usage probe timed out")), timeoutMs);
		const rl = createInterface({ input: child.stdout });

		function finish(error?: Error, value?: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rl.close();
			if (!child.killed) child.kill("SIGTERM");
			if (error) reject(error);
			else resolve(value);
		}

		child.on("error", finish);
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("exit", (code) => {
			if (!settled && code !== 0) finish(new Error(stderr.trim() || `codex exited with ${code}`));
		});
		rl.on("line", (line) => {
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.id !== 2) return;
			if (message.error) finish(new Error(message.error.message || "Codex rate limit request failed"));
			else finish(undefined, message.result);
		});

		writeJsonLine(child, { id: 1, method: "initialize", params: { clientInfo: { name: "pi-codex-usage", version: "0.1.0" } } });
		writeJsonLine(child, { method: "initialized", params: {} });
		writeJsonLine(child, { id: 2, method: "account/rateLimits/read", params: {} });
	});
}

function writeJsonLine(child: ReturnType<typeof spawn>, payload: unknown) {
	child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function buildCache(raw: any): Cache {
	const limits = pickDefaultLimit(raw);
	const fiveHour = formatWindow(limits.primary, "5h");
	const weekly = formatWindow(limits.secondary, "week");
	const name = limits.limitName ? ` ${limits.limitName}` : "";
	const plan = limits.planType ? ` (${limits.planType})` : "";
	const summary = `Codex${name}${plan}: ${fiveHour.label}; ${weekly.label}`;
	return {
		updatedAt: Date.now(),
		summary,
		statusText: `Codex ${fiveHour.short}/${weekly.short}`,
		promptText: `OpenAI Codex usage remaining: ${fiveHour.label}; ${weekly.label}. Prefer shorter/less speculative tool loops when low.`,
		raw,
	};
}

function pickDefaultLimit(raw: any): RateLimit {
	const rateLimitsByLimitId = raw?.rateLimitsByLimitId;
	return rateLimitsByLimitId?.codex ?? raw?.rateLimits ?? raw;
}

function formatWindow(window: RateWindow | undefined, label: string) {
	if (!window || typeof window.usedPercent !== "number") {
		return { label: `${label}: unknown`, short: "?" };
	}
	const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
	const reset = typeof window.resetsAt === "number" ? `, resets ${formatRelative(window.resetsAt * 1000 - Date.now())}` : "";
	const value = `${Math.round(remaining)}% left`;
	return { label: `${label}: ${value}${reset}`, short: `${Math.round(remaining)}%` };
}

function formatRelative(ms: number): string {
	if (!Number.isFinite(ms)) return "unknown";
	const abs = Math.abs(ms);
	const suffix = ms >= 0 ? "" : " ago";
	if (abs < 60_000) return `now${suffix}`;
	if (abs < 60 * 60_000) return `${Math.round(abs / 60_000)}m${suffix}`;
	if (abs < 48 * 60 * 60_000) return `${Math.round(abs / (60 * 60_000))}h${suffix}`;
	return `${Math.round(abs / (24 * 60 * 60_000))}d${suffix}`;
}

function formatAge(ms: number): string {
	const text = formatRelative(-Math.abs(ms));
	return text === "now ago" ? "just now" : text;
}

function readCache(): Cache | undefined {
	try {
		if (!existsSync(CACHE_PATH)) return undefined;
		return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
	} catch {
		return undefined;
	}
}

function writeCache(value: Cache) {
	mkdirSync(dirname(CACHE_PATH), { recursive: true });
	writeFileSync(CACHE_PATH, JSON.stringify(value, null, 2));
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
