import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const GIT_REFRESH_MS = 5_000;
const PR_REFRESH_MS = 60_000;
const CODEX_USAGE_REFRESH_MS = 15_000;
const CODEX_USAGE_STALE_MS = 15 * 60_000;
const COMMAND_TIMEOUT_MS = 3_000;
const CODEX_USAGE_CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "codex-usage.json");

type GitCache = {
	branch: string | null;
	status: string;
	inRepo: boolean;
};

type PrCache = {
	text: string;
	updatedAt: number;
};

type CodexUsageCache = {
	updatedAt: number;
	statusText: string;
	error?: string;
};

type FooterTheme = { fg(color: string, text: string): string };

type InfoPart = {
	text: string;
	/** Do not render optional parts below this width. Required parts may render smaller. */
	minWidth?: number;
	/** Per-part cap so one noisy segment cannot eat the whole prompt line. */
	maxWidth?: number;
	required?: boolean;
};

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

export default function promptFooter(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let disposed = false;
		let requestRender: (() => void) | undefined;
		let gitCache: GitCache = { branch: null, status: "", inRepo: false };
		let prCache: PrCache = { text: "", updatedAt: 0 };
		let codexUsageCache = readCodexUsageCache();
		let gitInFlight = false;
		let prInFlight = false;

		const renderSoon = () => {
			if (!disposed) requestRender?.();
		};

		async function refreshGit() {
			if (disposed || gitInFlight) return;
			gitInFlight = true;
			try {
				gitCache = await getGitStatus(ctx.cwd);
			} finally {
				gitInFlight = false;
				renderSoon();
			}
		}

		async function refreshPr() {
			if (disposed || prInFlight) return;
			prInFlight = true;
			try {
				prCache = { text: await getPrStatus(ctx.cwd), updatedAt: Date.now() };
			} finally {
				prInFlight = false;
				renderSoon();
			}
		}

		void refreshGit();
		void refreshPr();
		const gitTimer = setInterval(refreshGit, GIT_REFRESH_MS);
		const prTimer = setInterval(refreshPr, PR_REFRESH_MS);
		const codexUsageTimer = setInterval(() => {
			codexUsageCache = readCodexUsageCache();
			renderSoon();
		}, CODEX_USAGE_REFRESH_MS);

		pi.on("thinking_level_select", renderSoon);
		pi.on("model_select", renderSoon);
		pi.on("message_end", renderSoon);
		pi.on("session_shutdown", () => {
			disposed = true;
			clearInterval(gitTimer);
			clearInterval(prTimer);
			clearInterval(codexUsageTimer);
		});

		ctx.ui.setFooter(() => new EmptyFooter());

		class StarshipEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: 0 });
				requestRender = () => tui.requestRender();
			}

			render(width: number): string[] {
				const promptText = this.getText().trimStart().startsWith("!") ? " " : "❯ ";
				const prompt = ctx.ui.theme.fg("accent", promptText);
				const promptWidth = visibleWidth(prompt);
				const editorWidth = Math.max(1, width - promptWidth);
				const lines = super.render(editorWidth);
				const content = stripEditorBorders(lines);
				const info = renderInfoLine(width);

				if (content.length === 0) return [info, truncateToWidth(prompt, width)];
				return [
					info,
					...content.map((line, index) => {
						const prefix = index === 0 ? prompt : " ".repeat(promptWidth);
						return truncateToWidth(prefix + line, width, "");
					}),
				];
			}
		}

		const renderInfoLine = (width: number): string => {
			const theme = ctx.ui.theme;
			const safeWidth = Math.max(1, width - 1);
			const dir = basename(ctx.cwd) || ctx.cwd;
			const branch = gitCache.branch;
			const showBranch = Boolean(branch && branch !== dir);
			const thinking = pi.getThinkingLevel();
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}${thinking === "off" ? "" : `:${thinking}`}` : "no-model";
			const usage = getUsage(ctx.sessionManager.getBranch());
			const context = ctx.getContextUsage();

			const leftParts: InfoPart[] = [{ text: theme.fg("accent", `󰉋 ${dir}`), required: true, minWidth: 8 }];
			if (showBranch) leftParts.push({ text: theme.fg("success", ` ${branch}`), minWidth: 10 });
			if (gitCache.status) {
				leftParts.push({ text: gitCache.status === "clean" ? theme.fg("success", " clean") : theme.fg("warning", ` ${gitCache.status}`), minWidth: 5 });
			}
			if (prCache.text) leftParts.push({ text: theme.fg(prCache.text.includes("✗") ? "error" : "accent", ` ${prCache.text}`), minWidth: 12 });
			const isOpenAICodexModel = ctx.model?.provider === "openai-codex";
			const codexUsage = isOpenAICodexModel ? formatCodexUsage(codexUsageCache, theme) : "";

			const rightParts: InfoPart[] = [
				{ text: formatContextUsage(context, theme), required: true, minWidth: 7 },
				{ text: theme.fg("muted", `󰚩 ↑${formatCount(usage.input)} ↓${formatCount(usage.output)}`), minWidth: 8 },
				{ text: theme.fg(usage.cost > 0 ? "success" : "dim", `󰍢 $${usage.cost.toFixed(1)}`), minWidth: 5 },
				{ text: theme.fg(thinking === "off" ? "muted" : "warning", `󰚩 ${model}`), minWidth: 10 },
				{ text: codexUsage, minWidth: 10 },
			];

			return renderTwoColumnInfoLine(leftParts, rightParts, safeWidth, theme);
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new StarshipEditor(tui, theme, keybindings));
	});
}

function renderTwoColumnInfoLine(leftParts: InfoPart[], rightParts: InfoPart[], width: number, theme: FooterTheme): string {
	if (width <= 0) return "";

	const separator = theme.fg("dim", " ");
	const ellipsis = theme.fg("dim", "…");
	const rightBudget = width >= 120 ? Math.floor(width * 0.45) : width >= 80 ? Math.floor(width * 0.4) : Math.floor(width * 0.32);
	let right = fitInfoParts(
		withResponsiveCaps(rightParts, width, [18, 22, 9, Math.max(12, Math.floor(width * 0.26)), 24]),
		separator,
		Math.max(0, rightBudget),
		ellipsis,
	);
	let leftBudget = Math.max(1, width - visibleWidth(right) - (right ? 1 : 0));
	let left = fitInfoParts(
		withResponsiveCaps(leftParts, width, [Math.max(10, Math.floor(width * 0.22)), Math.max(12, Math.floor(width * 0.24)), 16, Math.max(14, Math.floor(width * 0.32))]),
		separator,
		leftBudget,
		ellipsis,
	);

	// If the cwd/branch/PR side is starved, sacrifice optional right-hand detail before truncating everything into soup.
	if (visibleWidth(left) < Math.min(24, Math.floor(width * 0.35)) && right) {
		const smallerRightBudget = Math.max(0, width - Math.min(width, Math.max(24, Math.floor(width * 0.5))) - 1);
		right = fitInfoParts(
			withResponsiveCaps(rightParts, width, [18, 18, 8, Math.max(10, Math.floor(width * 0.2)), 18]),
			separator,
			smallerRightBudget,
			ellipsis,
		);
		leftBudget = Math.max(1, width - visibleWidth(right) - (right ? 1 : 0));
		left = fitInfoParts(
			withResponsiveCaps(leftParts, width, [Math.max(10, Math.floor(width * 0.24)), Math.max(12, Math.floor(width * 0.28)), 16, Math.max(14, Math.floor(width * 0.36))]),
			separator,
			leftBudget,
			ellipsis,
		);
	}

	if (!right) return truncateToWidth(left, width, "");
	const padWidth = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(padWidth) + right, width, "");
}

function withResponsiveCaps(parts: InfoPart[], width: number, caps: number[]): InfoPart[] {
	return parts.map((part, index) => ({ ...part, maxWidth: Math.min(part.maxWidth ?? Number.POSITIVE_INFINITY, caps[index] ?? width) }));
}

function fitInfoParts(parts: InfoPart[], separator: string, width: number, ellipsis: string): string {
	if (width <= 0) return "";
	const fitted: string[] = [];
	let used = 0;

	for (const part of parts) {
		if (!part.text) continue;
		const separatorWidth = fitted.length > 0 ? visibleWidth(separator) : 0;
		const remaining = width - used - separatorWidth;
		if (remaining <= 0) break;

		const targetWidth = Math.min(visibleWidth(part.text), part.maxWidth ?? remaining, remaining);
		if (!part.required && targetWidth < (part.minWidth ?? 4)) continue;

		const rendered = truncateToWidth(part.text, Math.max(1, targetWidth), ellipsis);
		if (!rendered) continue;
		fitted.push(rendered);
		used += separatorWidth + visibleWidth(rendered);
	}

	return joinStyled(fitted, separator);
}


function readCodexUsageCache(): CodexUsageCache | undefined {
	try {
		if (!existsSync(CODEX_USAGE_CACHE_PATH)) return undefined;
		const parsed = JSON.parse(readFileSync(CODEX_USAGE_CACHE_PATH, "utf8")) as CodexUsageCache;
		if (typeof parsed.updatedAt !== "number" || typeof parsed.statusText !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function formatCodexUsage(usage: CodexUsageCache | undefined, theme: { fg(color: string, text: string): string }): string {
	if (!usage) return "";
	const stale = Date.now() - usage.updatedAt > CODEX_USAGE_STALE_MS;
	const values = usage.statusText.replace(/^Codex\s+/i, "");
	const text = stale ? `󰓅 ${values} stale` : `󰓅 ${values}`;
	if (usage.error || stale) return theme.fg("warning", text);
	return theme.fg("accent", text);
}

function joinStyled(parts: string[], separator: string): string {
	return parts.filter(Boolean).join(separator);
}

function getUsage(branch: readonly unknown[]): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of branch) {
		if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		const usage = (message as AssistantMessage).usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cost += usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function formatCount(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function formatContextCount(n: number): string {
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	return `${Math.round(n / 1_000_000)}m`;
}

function formatContextUsage(usage: unknown, theme: { fg(color: string, text: string): string }): string {
	const context = usage as { tokens?: number; contextWindow?: number; percent?: number | null } | null | undefined;
	if (!context) return theme.fg("dim", "?/?");

	const tokens = typeof context.tokens === "number" ? formatContextCount(context.tokens) : "?";
	const window = typeof context.contextWindow === "number" && context.contextWindow > 0 ? formatContextCount(context.contextWindow) : "?";
	const percent = typeof context.percent === "number" ? context.percent : null;
	const label = `󰾆 ${tokens}/${window}`;

	if (percent !== null && percent >= 90) return theme.fg("error", label);
	if (percent !== null && percent >= 70) return theme.fg("warning", label);
	return theme.fg("muted", label);
}

function stripEditorBorders(lines: string[]): string[] {
	if (lines.length <= 2) return [];
	const withoutTop = lines.slice(1);
	const bottomIndex = withoutTop.findIndex((line) => {
		const plain = stripAnsi(line).trim();
		return plain.length > 0 && [...plain].every((char) => char === "─");
	});
	if (bottomIndex >= 0) return [...withoutTop.slice(0, bottomIndex), ...withoutTop.slice(bottomIndex + 1)];
	return withoutTop;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

async function getGitStatus(cwd: string): Promise<GitCache> {
	try {
		const output = await run("git", ["status", "--porcelain=v1", "--branch"], cwd);
		const lines = output.split("\n").filter(Boolean);
		const header = lines.shift() ?? "";
		const branch = parseBranch(header);
		const counts = { added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0 };

		for (const line of lines) {
			const x = line[0] ?? " ";
			const y = line[1] ?? " ";
			if (line.startsWith("??")) counts.untracked++;
			else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) counts.conflicted++;
			else if (x === "R" || y === "R") counts.renamed++;
			else if (x === "A" || y === "A") counts.added++;
			else if (x === "D" || y === "D") counts.deleted++;
			else if (x === "M" || y === "M") counts.modified++;
		}

		const aheadBehind = parseAheadBehind(header);
		const parts = [
			aheadBehind,
			counts.added ? `+${counts.added}` : "",
			counts.modified ? `~${counts.modified}` : "",
			counts.deleted ? `-${counts.deleted}` : "",
			counts.renamed ? `»${counts.renamed}` : "",
			counts.untracked ? `?${counts.untracked}` : "",
			counts.conflicted ? `!${counts.conflicted}` : "",
		].filter(Boolean);

		return { branch, status: parts.length ? parts.join(" ") : "clean", inRepo: true };
	} catch {
		return { branch: null, status: "", inRepo: false };
	}
}

async function getPrStatus(cwd: string): Promise<string> {
	try {
		const json = await run("gh", ["pr", "view", "--json", "number,state,reviewDecision,statusCheckRollup,isDraft"], cwd, 8_000);
		const pr = JSON.parse(json) as {
			number?: number;
			state?: string;
			reviewDecision?: string;
			isDraft?: boolean;
			statusCheckRollup?: Array<{ conclusion?: string; status?: string }>;
		};
		if (!pr.number) return "";
		const checks = pr.statusCheckRollup ?? [];
		const pending = checks.filter((c) => c.status && c.status !== "COMPLETED").length;
		const failing = checks.filter((c) => c.conclusion && c.conclusion !== "SUCCESS" && c.conclusion !== "SKIPPED").length;
		const checkText = pending ? `checks:${pending}…` : failing ? `checks:${failing}✗` : checks.length ? "checks:✓" : "checks:—";
		const review = pr.reviewDecision ? pr.reviewDecision.toLowerCase().replaceAll("_", "-") : "no-review";
		const draft = pr.isDraft ? " draft" : "";
		return `PR #${pr.number}${draft} ${review} ${checkText}`;
	} catch {
		return "";
	}
}

function parseBranch(header: string): string | null {
	const match = header.match(/^## (.+?)(?:\.\.\.|$)/);
	return match?.[1] && match[1] !== "HEAD (no branch)" ? match[1] : null;
}

function parseAheadBehind(header: string): string {
	const ahead = header.match(/ahead (\d+)/)?.[1];
	const behind = header.match(/behind (\d+)/)?.[1];
	return [ahead ? `↑${ahead}` : "", behind ? `↓${behind}` : ""].filter(Boolean).join(" ");
}

function run(command: string, args: string[], cwd: string, timeout = COMMAND_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout.trim());
		});
	});
}
