import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { Container, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import simpleGit, { type SimpleGit } from "simple-git";

const POST_CREATE_CONFIG_KEY = "pi.wt.postCreateCommand";
const DEFAULT_POST_CREATE_COMMAND = "mise trust";
const START_CONFIG_KEY = "pi.wt.startCommand";
const DEFAULT_START_COMMAND = "./scripts/worktree-start.sh";
const WT_EXTENSION_VERSION = "wt-v3-jira-title-async";

export default function worktreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("wt", {
		description: "Create/open a git worktree, /wt setup configures post-create setup, /wt start starts the stack",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			let subcommandOrBranch = args.trim();

			let repoRoot: string;
			let git: SimpleGit;
			try {
				repoRoot = (await simpleGit(ctx.cwd).raw(["rev-parse", "--show-toplevel"])).trim();
				git = simpleGit({ baseDir: repoRoot, maxConcurrentProcesses: 1 });
			} catch (error) {
				ctx.ui.notify(`Not inside a git repository\n${formatError(error)}`, "error");
				return;
			}

			if (subcommandOrBranch === "setup") {
				await setupPostCreateCommand(git, ctx);
				return;
			}

			if (subcommandOrBranch === "start setup" || subcommandOrBranch === "setup start") {
				await setupStartCommand(git, ctx);
				return;
			}

			if (subcommandOrBranch === "start") {
				await startCurrentWorktree(git, ctx, repoRoot);
				return;
			}

			const sourceRepoRoot = await getWorktreeSourceRoot(git, repoRoot);

			let selectedExistingWorktree: ExistingWorktree | undefined;
			if (!subcommandOrBranch) {
				const selected = await selectWorktreeOrCreate(git, ctx, sourceRepoRoot);
				if (!selected) return;
				if (selected.type === "open") {
					selectedExistingWorktree = { path: selected.entry.path, branch: selected.entry.branch };
					subcommandOrBranch = selected.entry.branch ?? selected.entry.title;
				} else {
					subcommandOrBranch = selected.branch;
				}
			}

			ctx.ui.notify(`${WT_EXTENSION_VERSION}: preparing worktree for ${subcommandOrBranch}...`, "info");
			void (async () => {
			let branch = await resolveBranchArg(subcommandOrBranch, git, ctx);
			try {
				await assertValidBranchName(git, branch);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
				return;
			}

			let defaultBranch: string;
			try {
				defaultBranch = await getDefaultBranch(git);
			} catch (error) {
				ctx.ui.notify(`Could not find default branch\n${formatError(error)}`, "error");
				return;
			}

			let cmuxWorkspaceTitle = `${basename(sourceRepoRoot)}.${branch}`;
			const worktreeRoot = `${sourceRepoRoot}.wt`;
			let worktreePath = resolve(worktreeRoot, branch);
			if (!isPathInside(worktreeRoot, worktreePath)) {
				ctx.ui.notify(`Refusing to create worktree outside ${worktreeRoot}: ${worktreePath}`, "error");
				return;
			}

			let cmuxWorkspace: { id: string; created: boolean } | undefined;
			let isExistingWorktree = false;
			try {
				const existingWorktree = selectedExistingWorktree ?? await findExistingWorktree(git, branch, worktreePath);
				if (existingWorktree) {
					isExistingWorktree = true;
					branch = existingWorktree.branch ?? branch;
					cmuxWorkspaceTitle = `${basename(sourceRepoRoot)}.${branch}`;
					worktreePath = existingWorktree.path;
					ctx.ui.notify(`Opening existing worktree: ${existingWorktree.path}`, "info");
					cmuxWorkspace = await openCmuxWorkspace(cmuxWorkspaceTitle, ctx);
				} else {
					await mkdir(dirname(worktreePath), { recursive: true });
					ctx.ui.notify(`Creating ${worktreePath}...`, "info");
					const sourceRef = await addWorktree(git, worktreePath, branch, defaultBranch);
					ctx.ui.notify(`Worktree created from ${sourceRef}: ${worktreePath}`, "info");
					cmuxWorkspace = await openCmuxWorkspace(cmuxWorkspaceTitle, ctx);
				}
			} catch (error) {
				ctx.ui.notify(`git worktree failed\n${formatError(error)}`, "error");
				return;
			}

			try {
				await ensurePushConfig(git, branch);
			} catch (error) {
				ctx.ui.notify(`Could not normalize git push config (ignored)
${formatError(error)}`, "warning");
			}

			if (!cmuxWorkspace || !process.env.CMUX_SOCKET_PATH) return;
			if (!cmuxWorkspace.created) {
				ctx.ui.notify(`Selected existing cmux workspace: ${cmuxWorkspaceTitle}`, "info");
				return;
			}

			const postCreateCommand = isExistingWorktree ? undefined : await getPostCreateCommand(git);
			try {
				await initializeCmuxWorkspace(process.env.CMUX_SOCKET_PATH, cmuxWorkspace.id, {
					command: postCreateCommand,
					title: cmuxWorkspaceTitle,
					branch,
					worktreePath,
					defaultBranch,
					sourceRepoRoot,
				});
				ctx.ui.notify(postCreateCommand ? "postCreateCommand started in cmux workspace" : "cmux workspace initialized", "info");
			} catch (error) {
				ctx.ui.notify(`cmux workspace init command could not be sent (ignored)\n${formatError(error)}`, "warning");
			}
			})().catch((error) => {
				ctx.ui.notify(`worktree command failed\n${formatError(error)}`, "error");
			});
			return;
		},
	});

	pi.registerCommand("start", {
		description: "Start the current worktree stack in cmux; /start setup configures the start command",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			let repoRoot: string;
			let git: SimpleGit;
			try {
				repoRoot = (await simpleGit(ctx.cwd).raw(["rev-parse", "--show-toplevel"])).trim();
				git = simpleGit({ baseDir: repoRoot, maxConcurrentProcesses: 1 });
			} catch (error) {
				ctx.ui.notify(`Not inside a git repository\n${formatError(error)}`, "error");
				return;
			}

			const subcommand = args.trim();
			if (subcommand === "setup") {
				await setupStartCommand(git, ctx);
				return;
			}

			if (subcommand) {
				ctx.ui.notify("Usage: /start or /start setup", "error");
				return;
			}

			await startCurrentWorktree(git, ctx, repoRoot);
		},
	});
}

async function startCurrentWorktree(git: SimpleGit, ctx: ExtensionCommandContext, repoRoot: string): Promise<void> {
	const socketPath = process.env.CMUX_SOCKET_PATH;
	if (!socketPath) {
		ctx.ui.notify("/wt start requires cmux (CMUX_SOCKET_PATH is not set)", "error");
		return;
	}

	let branch: string;
	try {
		branch = (await git.raw(["branch", "--show-current"])).trim();
		if (!branch) throw new Error("Detached HEAD or no current branch");
	} catch (error) {
		ctx.ui.notify(`Could not determine current branch\n${formatError(error)}`, "error");
		return;
	}

	let defaultBranch = "HEAD";
	try {
		defaultBranch = await getDefaultBranch(git);
	} catch {
		// Only used for exported metadata. Starting should not hard fail if origin/HEAD is weird.
	}

	const sourceRepoRoot = await getWorktreeSourceRoot(git, repoRoot);
	const cmuxWorkspaceTitle = `${basename(sourceRepoRoot)}.${branch}`;
	const cmuxWorkspace = await openCmuxWorkspace(cmuxWorkspaceTitle, ctx);
	if (!cmuxWorkspace) return;

	const startCommand = await getStartCommand(git);
	try {
		await initializeCmuxWorkspace(socketPath, cmuxWorkspace.id, {
			command: startCommand,
			title: cmuxWorkspaceTitle,
			branch,
			worktreePath: repoRoot,
			defaultBranch,
			sourceRepoRoot,
		});
		ctx.ui.notify(`startCommand sent: ${startCommand}`, "info");
	} catch (error) {
		ctx.ui.notify(`cmux start command could not be sent\n${formatError(error)}`, "error");
	}
}


type WorktreeMenuEntry = { path: string; branch?: string; title: string; createdAt: number };

type WorktreeMenuChoice = { type: "open"; entry: WorktreeMenuEntry } | { type: "create"; branch: string };

async function selectWorktreeOrCreate(git: SimpleGit, ctx: ExtensionCommandContext, sourceRepoRoot: string): Promise<WorktreeMenuChoice | undefined> {
	const entries = await listWorktreeMenuEntries(git, sourceRepoRoot);
	const choice = await ctx.ui.custom<WorktreeMenuChoice | undefined>((tui, theme, keybindings, done) => {
		const picker = new WorktreePicker(entries, done, () => tui.requestRender(), theme, keybindings);
		return picker;
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: 18,
			margin: { top: 0, right: 0, bottom: 1, left: 0 },
		},
	});

	return choice;
}

async function listWorktreeMenuEntries(git: SimpleGit, sourceRepoRoot: string): Promise<WorktreeMenuEntry[]> {
	const worktrees = await parseWorktreeList(git);
	const entries = await Promise.all(worktrees
		.filter((entry) => entry.branch && entry.path !== sourceRepoRoot)
		.map(async (entry) => {
			const stats = await stat(entry.path).catch(() => undefined);
			return {
				path: entry.path,
				branch: entry.branch,
				title: entry.branch ?? basename(entry.path),
				createdAt: stats?.birthtimeMs || stats?.ctimeMs || stats?.mtimeMs || 0,
			};
		}));
	return entries.sort((a, b) => b.createdAt - a.createdAt);
}

class WorktreePicker implements Component {
	private query = "";
	private selectedIndex = 0;
	private readonly maxVisible = 8;

	constructor(
		private readonly entries: WorktreeMenuEntry[],
		private readonly done: (value: WorktreeMenuChoice | undefined) => void,
		private readonly requestRender: () => void,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
		private readonly keybindings: KeybindingsManager,
	) {}

	render(width: number): string[] {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("󰘬 Worktrees")), 1, 0));
		container.addChild(new Text(`${this.theme.fg("muted", "search/create:")} ${this.query || this.theme.fg("dim", "type to filter")}`, 1, 0));
		container.addChild({ render: (w) => this.renderItems(w), invalidate: () => {} });
		container.addChild(new Text(this.theme.fg("dim", "↑↓ navigate • enter open/create • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		return container.render(width);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
		else if (this.keybindings.matches(data, "tui.select.confirm")) this.select();
		else if (data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.selectedIndex = 0;
		} else if (isPrintableInput(data)) {
			this.query += data;
			this.selectedIndex = 0;
		}
		this.requestRender();
	}

	invalidate(): void {}

	private renderItems(width: number): string[] {
		const items = this.filteredEntries();
		if (items.length === 0) {
			const create = this.createChoice();
			return [this.theme.fg("accent", truncateToWidth(`→ 󰐕 Create new ${create ? `'${create}'` : "worktree"}`, width, ""))];
		}

		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), items.length - this.maxVisible));
		const visible = items.slice(start, start + this.maxVisible);
		const lines = visible.map((entry, offset) => this.renderEntry(entry, start + offset === this.selectedIndex, width));
		if (items.length > this.maxVisible) lines.push(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`));
		return lines;
	}

	private renderEntry(entry: WorktreeMenuEntry, selected: boolean, width: number): string {
		const prefix = selected ? "→ " : "  ";
		const label = ` ${entry.title}`;
		const age = entry.createdAt ? ` ${formatRelativeAge(Date.now() - entry.createdAt)}` : "";
		const desc = ` ${entry.path}${age}`;
		const labelWidth = visibleWidth(prefix + label);
		const text = `${prefix}${label}${this.theme.fg("dim", truncateToWidth(desc, Math.max(0, width - labelWidth - 1), ""))}`;
		return selected ? this.theme.fg("accent", truncateToWidth(text, width, "")) : truncateToWidth(text, width, "");
	}

	private filteredEntries(): WorktreeMenuEntry[] {
		const query = this.query.trim().toLowerCase();
		if (!query) return this.entries;
		return this.entries
			.map((entry) => ({ entry, score: fuzzyScore(`${entry.title} ${entry.path}`, query) }))
			.filter((item) => item.score >= 0)
			.sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
			.map((item) => item.entry);
	}

	private move(delta: number): void {
		const count = Math.max(1, this.filteredEntries().length);
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}

	private select(): void {
		const items = this.filteredEntries();
		if (items.length === 0) {
			const branch = this.createChoice();
			if (branch) this.done({ type: "create", branch });
			return;
		}
		const entry = items[this.selectedIndex];
		if (entry) this.done({ type: "open", entry });
	}

	private createChoice(): string {
		return sanitizeBranchPart(this.query);
	}
}

function isPrintableInput(data: string): boolean {
	return ![...data].some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

function fuzzyScore(text: string, query: string): number {
	let score = 0;
	let index = 0;
	const haystack = text.toLowerCase();
	for (const char of query) {
		const found = haystack.indexOf(char, index);
		if (found < 0) return -1;
		score += found === index ? 3 : 1;
		index = found + 1;
	}
	return score - haystack.length / 1000;
}

function formatRelativeAge(ms: number): string {
	if (ms < 60_000) return "now";
	if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
	if (ms < 48 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
	return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
}

function normalizeBranchArg(raw: string): string {
	return raw.replace(/^new\s+/, "").trim();
}

async function resolveBranchArg(raw: string, git: SimpleGit, ctx: ExtensionCommandContext): Promise<string> {
	const normalized = normalizeBranchArg(raw);
	const issueKey = parseJiraIssueKey(normalized);
	if (!issueKey) {
		if (await isValidBranchName(git, normalized) && await localBranchExists(git, normalized)) return normalized;
		return normalized;
	}

	if (!looksLikeJiraUrl(normalized) && await isValidBranchName(git, normalized) && await localBranchExists(git, normalized)) return normalized;
	if (!looksLikeJiraUrl(normalized) && await isValidBranchName(git, normalized)) return normalized;

	const base = issueKey.toLowerCase();
	if (await localBranchExists(git, base)) return base;

	const existingBranches = await localBranchesWithPrefix(git, `${base}-`);
	if (existingBranches.length === 1) return existingBranches[0];

	try {
		const title = await fetchJiraIssueTitle(issueKey, 15000);
		const slug = sanitizeBranchPart(title);
		const titleBranch = slug ? `${base}-${slug}` : base;
		if (await localBranchExists(git, titleBranch)) return titleBranch;
		return titleBranch;
	} catch (error) {
		throw new Error(`Could not fetch Jira title for ${issueKey}; refusing to create bare ${base}\n${formatError(error)}`);
	}
}

function parseJiraIssueKey(value: string): string | undefined {
	const match = value.match(/(?:^|\/|\b)([A-Z][A-Z0-9]+-\d+)(?:\b|$)/i);
	return match?.[1]?.toUpperCase();
}

function looksLikeJiraUrl(value: string): boolean {
	return /^https?:\/\//i.test(value) && /\/browse\/[A-Z][A-Z0-9]+-\d+/i.test(value);
}

function fetchJiraIssueTitle(issueKey: string, timeoutMs: number): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = execFile("jira", ["issue", "view", issueKey, "--plain"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			const title = parseJiraTitle(stdout);
			if (!title) {
				reject(new Error(`Could not parse Jira title for ${issueKey}`));
				return;
			}
			resolvePromise(title);
		});
		child.on("error", reject);
	});
}

function parseJiraTitle(output: string): string | undefined {
	for (const line of stripAnsi(output).split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) return trimmed.slice(2).trim();
	}
	return undefined;
}

function sanitizeBranchPart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 80)
		.replace(/-+$/g, "");
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function assertValidBranchName(git: SimpleGit, branch: string): Promise<void> {
	try {
		await git.raw(["check-ref-format", "--branch", branch]);
	} catch {
		throw new Error(`Invalid branch name: ${branch}`);
	}
}

async function isValidBranchName(git: SimpleGit, branch: string): Promise<boolean> {
	try {
		await git.raw(["check-ref-format", "--branch", branch]);
		return true;
	} catch {
		return false;
	}
}

async function localBranchesWithPrefix(git: SimpleGit, prefix: string): Promise<string[]> {
	const output = await tryRaw(git, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	if (!output) return [];
	return output.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(prefix));
}

async function remoteBranchesWithPrefix(git: SimpleGit, prefix: string): Promise<string[]> {
	const output = await tryRaw(git, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
	const cachedBranches = output ? output.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.endsWith("/HEAD"))
		.map(remoteRefToBranchName)
		.filter((line): line is string => Boolean(line?.startsWith(prefix))) : [];
	const remoteBranches = await lsRemoteBranchesWithPattern(git, `${prefix}*`);
	const branches = [...cachedBranches, ...remoteBranches];
	return [...new Set(branches)];
}

function remoteRefToBranchName(ref: string): string | undefined {
	const slashIndex = ref.indexOf("/");
	if (slashIndex < 0) return undefined;
	return ref.slice(slashIndex + 1);
}

async function openCmuxWorkspace(title: string, ctx: ExtensionCommandContext): Promise<{ id: string; created: boolean } | undefined> {
	const socketPath = process.env.CMUX_SOCKET_PATH;
	if (!socketPath) return undefined;

	try {
		const existingWorkspaceId = await findCmuxWorkspaceByTitle(socketPath, title);
		if (existingWorkspaceId) {
			await cmuxSocketCommand(socketPath, `select_workspace ${existingWorkspaceId}`);
			ctx.ui.notify(`Selected existing cmux workspace: ${title}`, "info");
			return { id: existingWorkspaceId, created: false };
		}

		const response = await cmuxSocketCommand(socketPath, "new_workspace");
		if (!response.startsWith("OK ")) throw new Error(response);
		const workspaceId = response.slice("OK ".length).trim();
		await cmuxSocketCommand(socketPath, `select_workspace ${workspaceId}`);
		await delay(500);
		ctx.ui.notify(`Opened cmux workspace: ${title}`, "info");
		return { id: workspaceId, created: true };
	} catch (error) {
		ctx.ui.notify(`Could not open cmux workspace (ignored)\n${formatError(error)}`, "warning");
		return undefined;
	}
}

async function findCmuxWorkspaceByTitle(socketPath: string, title: string): Promise<string | undefined> {
	const output = await cmuxSocketCommand(socketPath, "list_workspaces");
	for (const line of output.split("\n")) {
		const match = line.match(/^\*?\s*\d+:\s+([^\s]+)\s+(.+)$/);
		if (match?.[2]?.trim() === title) return match[1];
	}
	return undefined;
}

async function initializeCmuxWorkspace(
	socketPath: string,
	workspaceId: string,
	options: { command?: string; title: string; branch: string; worktreePath: string; defaultBranch: string; sourceRepoRoot: string },
): Promise<void> {
	await cmuxSocketCommand(socketPath, `select_workspace ${workspaceId}`);
	await delay(500);
	const env = [
		`PI_WT_BRANCH=${shellQuote(options.branch)}`,
		`PI_WT_PATH=${shellQuote(options.worktreePath)}`,
		`PI_WT_DEFAULT_BRANCH=${shellQuote(options.defaultBranch)}`,
		`PI_WT_REPO=${shellQuote(options.sourceRepoRoot)}`,
	].join(" ");
	const parts = [
		`cd ${shellQuote(options.worktreePath)}`,
		`export ${env}`,
		options.command ? `{ ${options.command}; }` : undefined,
		renameWorkspaceCommand(workspaceId, options.title),
	].filter(Boolean);
	const surfaceId = await getCurrentCmuxSurface(socketPath);
	if (surfaceId) {
		await cmuxSocketCommand(socketPath, `send_surface ${surfaceId}  ${parts.join("; ")}`);
		await cmuxSocketCommand(socketPath, `send_key_surface ${surfaceId} enter`);
		return;
	}
	await cmuxSocketCommand(socketPath, `send  ${parts.join("; ")}`);
	await cmuxSocketCommand(socketPath, "send_key enter");
}

async function getCurrentCmuxSurface(socketPath: string): Promise<string | undefined> {
	const output = await cmuxSocketCommand(socketPath, "list_surfaces");
	for (const line of output.split("\n")) {
		const match = line.match(/^\*\s*\d+:\s+([^\s]+)/);
		if (match?.[1]) return match[1];
	}
	const fallback = output.match(/^\s*\d+:\s+([^\s]+)/m);
	return fallback?.[1];
}
function cmuxSocketCommand(socketPath: string, command: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		let output = "";
		const socket = createConnection(socketPath);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`cmux socket timeout: ${command}`));
		}, 2000);

		socket.setEncoding("utf8");
		socket.on("connect", () => socket.end(`${command}\n`));
		socket.on("data", (chunk) => { output += chunk; });
		socket.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			resolvePromise(output.trim());
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function renameWorkspaceCommand(workspaceId: string, title: string): string {
	return `cmux rename-workspace --workspace ${shellQuote(workspaceId)} ${shellQuote(title)}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\''`)}'`;
}

type ParsedWorktree = { path: string; branch?: string };

async function parseWorktreeList(git: SimpleGit): Promise<ParsedWorktree[]> {
	const entries = await git.raw(["worktree", "list", "--porcelain"]);
	const worktrees: ParsedWorktree[] = [];
	let currentPath: string | undefined;
	let currentBranchRef: string | undefined;
	const shortBranch = (ref: string | undefined): string | undefined => ref?.replace(/^refs\/heads\//, "");
	const record = () => {
		if (currentPath) worktrees.push({ path: currentPath, branch: shortBranch(currentBranchRef) });
	};
	for (const line of entries.split("\n")) {
		if (!line.trim()) {
			record();
			currentPath = undefined;
			currentBranchRef = undefined;
		} else if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
		else if (line.startsWith("branch ")) currentBranchRef = line.slice("branch ".length);
	}
	record();
	return worktrees;
}

type ExistingWorktree = { path: string; branch?: string };

async function findExistingWorktree(git: SimpleGit, branch: string, preferredPath: string): Promise<ExistingWorktree | undefined> {
	const worktrees = await parseWorktreeList(git);
	const exact: ExistingWorktree[] = [];
	const suffix: ExistingWorktree[] = [];
	const basenameOf = (path: string): string => path.split(/[\\/]/).pop() || path;

	for (const entry of worktrees) {
		const pathBase = basenameOf(entry.path);
		const candidate = { path: entry.path, branch: entry.branch };
		if (entry.path === preferredPath || entry.branch === branch || pathBase === branch) exact.push(candidate);
		else if (entry.branch?.endsWith(`-${branch}`) || pathBase.endsWith(`-${branch}`)) suffix.push(candidate);
	}

	if (exact.length > 0) return exact[0];
	if (suffix.length === 1) return suffix[0];
	if (suffix.length > 1) throw new Error(`Multiple existing worktrees match '${branch}': ${suffix.map((entry) => entry.branch ?? entry.path).join(", ")}`);
	return undefined;
}

async function ensurePushConfig(git: SimpleGit, branch: string): Promise<void> {
	await git.raw(["config", "push.autoSetupRemote", "true"]);
	const mergeRef = (await tryRaw(git, ["config", "--get", `branch.${branch}.merge`]))?.trim();
	if (mergeRef && mergeRef !== `refs/heads/${branch}`) {
		await tryRaw(git, ["branch", "--unset-upstream", branch]);
	}
}

async function addWorktree(git: SimpleGit, worktreePath: string, branch: string, defaultBranch: string): Promise<string> {
	if (await localBranchExists(git, branch)) {
		await git.raw(["worktree", "add", worktreePath, branch]);
		return branch;
	}

	const remoteBranch = await ensureRemoteBranchRef(git, branch);
	if (remoteBranch) {
		await git.raw(["worktree", "add", "--track", "-b", branch, worktreePath, remoteBranch]);
		return remoteBranch;
	}

	const sourceRef = await refExists(git, `${defaultBranch}^{commit}`) ? defaultBranch : "HEAD";
	await git.raw(["worktree", "add", "--no-track", "-b", branch, worktreePath, sourceRef]);
	return sourceRef;
}

async function describeWorktreeSource(git: SimpleGit, branch: string, defaultBranch: string): Promise<string> {
	if (await localBranchExists(git, branch)) return branch;
	const remoteBranch = await findRemoteBranch(git, branch);
	if (remoteBranch) return remoteBranch;
	if (await lsRemoteBranchExists(git, branch)) return `origin/${branch}`;
	return await refExists(git, `${defaultBranch}^{commit}`) ? defaultBranch : "HEAD";
}

async function getWorktreeSourceRoot(git: SimpleGit, repoRoot: string): Promise<string> {
	const commonGitDir = await tryRaw(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonGitDir) return repoRoot;

	return commonGitDir.endsWith(`${sep}.git`) ? dirname(commonGitDir) : repoRoot;
}

async function getDefaultBranch(git: SimpleGit): Promise<string> {
	const originHead = await tryRaw(git, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead) return originHead.trim();

	for (const candidate of ["origin/main", "origin/master", "main", "master", "HEAD"]) {
		if (await refExists(git, `${candidate}^{commit}`)) return candidate;
	}

	throw new Error("Tried origin/HEAD, origin/main, origin/master, main, master, and HEAD");
}

async function refExists(git: SimpleGit, ref: string): Promise<boolean> {
	try {
		const output = await git.raw(["rev-parse", "--verify", ref]);
		if (!output.trim()) return false;
		return true;
	} catch {
		return false;
	}
}

async function localBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
	try {
		const output = await git.raw(["show-ref", "--verify", `refs/heads/${branch}`]);
		if (!output.trim()) return false;
		return true;
	} catch {
		return false;
	}
}

async function remoteBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
	return (await findRemoteBranch(git, branch)) !== undefined || (await lsRemoteBranchExists(git, branch));
}

async function findRemoteBranch(git: SimpleGit, branch: string): Promise<string | undefined> {
	if (await refExists(git, `refs/remotes/origin/${branch}^{commit}`)) return `origin/${branch}`;

	const output = await tryRaw(git, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]);
	if (!output) return undefined;
	const matches = output.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.endsWith("/HEAD"))
		.filter((line) => remoteRefToBranchName(line) === branch);
	return matches.find((line) => line.startsWith("origin/")) ?? matches[0];
}

async function ensureRemoteBranchRef(git: SimpleGit, branch: string): Promise<string | undefined> {
	const cached = await findRemoteBranch(git, branch);
	if (cached) return cached;
	if (!(await lsRemoteBranchExists(git, branch))) return undefined;
	await git.raw(["fetch", "--quiet", "origin", `${branch}:refs/remotes/origin/${branch}`]);
	return `origin/${branch}`;
}

async function lsRemoteBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
	return (await lsRemoteBranchesWithPattern(git, branch)).includes(branch);
}

async function lsRemoteBranchesWithPattern(git: SimpleGit, pattern: string): Promise<string[]> {
	const output = await tryRaw(git, ["ls-remote", "--heads", "origin", pattern]);
	if (!output) return [];
	return output.split("\n")
		.map((line) => line.trim().split(/\s+/)[1])
		.filter((ref): ref is string => Boolean(ref?.startsWith("refs/heads/")))
		.map((ref) => ref.replace(/^refs\/heads\//, ""));
}

async function tryRaw(git: SimpleGit, args: string[]): Promise<string | undefined> {
	try {
		const output = await git.raw(args);
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function setupPostCreateCommand(git: SimpleGit, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/wt setup requires interactive mode", "error");
		return;
	}

	const current = await getPostCreateCommand(git);
	const command = await ctx.ui.editor(
		`Set ${POST_CREATE_CONFIG_KEY} (empty clears it)`,
		current ?? DEFAULT_POST_CREATE_COMMAND,
	);
	if (command === undefined) return;

	const trimmed = command.trim();
	if (!trimmed) {
		await git.raw(["config", "--local", "--unset", POST_CREATE_CONFIG_KEY]).catch(() => undefined);
		ctx.ui.notify(`Cleared ${POST_CREATE_CONFIG_KEY}`, "info");
		return;
	}

	await git.raw(["config", "--local", POST_CREATE_CONFIG_KEY, trimmed]);
	ctx.ui.notify(`Set ${POST_CREATE_CONFIG_KEY}`, "info");
}

async function getPostCreateCommand(git: SimpleGit): Promise<string | undefined> {
	return tryRaw(git, ["config", "--local", "--get", POST_CREATE_CONFIG_KEY]);
}

async function setupStartCommand(git: SimpleGit, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/wt start setup requires interactive mode", "error");
		return;
	}

	const current = await tryRaw(git, ["config", "--local", "--get", START_CONFIG_KEY]);
	const command = await ctx.ui.editor(
		`Set ${START_CONFIG_KEY} (empty resets to default: ${DEFAULT_START_COMMAND})`,
		current ?? DEFAULT_START_COMMAND,
	);
	if (command === undefined) return;

	const trimmed = command.trim();
	if (!trimmed) {
		await git.raw(["config", "--local", "--unset", START_CONFIG_KEY]).catch(() => undefined);
		ctx.ui.notify(`Reset ${START_CONFIG_KEY} to default`, "info");
		return;
	}

	await git.raw(["config", "--local", START_CONFIG_KEY, trimmed]);
	ctx.ui.notify(`Set ${START_CONFIG_KEY}`, "info");
}

async function getStartCommand(git: SimpleGit): Promise<string> {
	return (await tryRaw(git, ["config", "--local", "--get", START_CONFIG_KEY])) ?? DEFAULT_START_COMMAND;
}

function isPathInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}


function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
