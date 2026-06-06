import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { constants, readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import bigrams from "./bigrams.json" with { type: "json" };

type HashlineAnchor = { line: number; hash: string };
type HashlineOp =
	| { type: "insert"; path: string; where: "before" | "after"; anchor: HashlineAnchor | "BOF" | "EOF"; payload: string[] }
	| { type: "replace"; path: string; start: HashlineAnchor; end: HashlineAnchor; payload: string[] };

// V4A (Codex/OpenAI) patch types
type V4AChunk = { origIndex: number; delLines: string[]; insLines: string[] };
type V4AOp =
	| { type: "add"; path: string; diff: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; diff: string; moveTo?: string };

type OperationSummary = {
	type: "Update";
	path: string;
	added: number;
	removed: number;
	hunks: number;
};

type ToolTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};
type PreviewLine = { kind: "add" | "remove" | "warning"; text: string };
type PreviewEntry = { path: string; lines: PreviewLine[] };

const HASHLINE_FILE_PREFIX = "§";
const HASHLINE_INSERT_AFTER = "»";
const HASHLINE_INSERT_BEFORE = "«";
const HASHLINE_REPLACE = "≔";
const HASHLINE_OP_CHARS = `${HASHLINE_INSERT_AFTER}${HASHLINE_INSERT_BEFORE}${HASHLINE_REPLACE}`;
const END_PATCH = "*** End Patch";

const patchSchema = Type.Object(
	{
		input: Type.String({
			description:
				"Hashline edit input. Use one or more sections starting with §PATH. Ops: »ANCHOR insert after, «ANCHOR insert before, ≔A..B replace/delete. Anchors come from read output as LINEhh|TEXT.",
		}),
	},
	{ additionalProperties: false },
);

function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: "\ufeff", text: text.slice(1) } : { bom: "", text };
}

function lineEndingOf(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function fromLF(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function resolvePatchPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
}

function xxhash32(input: string, seed = 0): number {
	const bytes = new TextEncoder().encode(input);
	let offset = 0;
	let hash: number;
	const p1 = 0x9e3779b1;
	const p2 = 0x85ebca77;
	const p3 = 0xc2b2ae3d;
	const p4 = 0x27d4eb2f;
	const p5 = 0x165667b1;
	const rotl = (value: number, bits: number) => ((value << bits) | (value >>> (32 - bits))) >>> 0;
	const read32 = () => {
		const value = (bytes[offset]!) | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24);
		offset += 4;
		return value;
	};
	const round = (acc: number, lane: number) => Math.imul(rotl((acc + Math.imul(lane, p2)) >>> 0, 13), p1) >>> 0;

	if (bytes.length >= 16) {
		let v1 = (seed + p1 + p2) >>> 0;
		let v2 = (seed + p2) >>> 0;
		let v3 = seed >>> 0;
		let v4 = (seed - p1) >>> 0;
		const limit = bytes.length - 16;
		while (offset <= limit) {
			v1 = round(v1, read32());
			v2 = round(v2, read32());
			v3 = round(v3, read32());
			v4 = round(v4, read32());
		}
		hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
	} else {
		hash = (seed + p5) >>> 0;
	}

	hash = (hash + bytes.length) >>> 0;
	while (offset + 4 <= bytes.length) {
		const lane = read32();
		hash = Math.imul(rotl((hash + Math.imul(lane, p3)) >>> 0, 17), p4) >>> 0;
	}
	while (offset < bytes.length) {
		hash = Math.imul(rotl((hash + Math.imul(bytes[offset++]!, p5)) >>> 0, 11), p1) >>> 0;
	}
	hash ^= hash >>> 15;
	hash = Math.imul(hash, p2) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, p3) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

function computeHashlineHash(_lineNumber: number, line: string): string {
	const table = bigrams as string[];
	return table[xxhash32(line.replace(/\r/g, "").trimEnd(), 0) % table.length]!;
}

function formatHashlineLine(lineNumber: number, line: string): string {
	return `${lineNumber}${computeHashlineHash(lineNumber, line)}|${line}`;
}

function formatHashlineText(text: string, startLine = 1): string {
	return text.split("\n").map((line, index) => formatHashlineLine(startLine + index, line)).join("\n");
}

function parseHashlineAnchor(raw: string, sourceLine: number): HashlineAnchor {
	const match = /^(\d+)([a-z]{2})$/.exec(raw);
	if (!match) throw new Error(`hashline line ${sourceLine}: expected anchor like 12ab; got ${JSON.stringify(raw)}.`);
	return { line: Number.parseInt(match[1]!, 10), hash: match[2]! };
}

function parseHashlineCursor(raw: string, sourceLine: number): HashlineAnchor | "BOF" | "EOF" {
	if (raw === "BOF" || raw === "EOF") return raw;
	return parseHashlineAnchor(raw, sourceLine);
}

function parseHashlineRange(raw: string, sourceLine: number): { start: HashlineAnchor; end: HashlineAnchor } {
	const parts = raw.includes("..") ? raw.split("..") : [raw, raw];
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`hashline line ${sourceLine}: range must be A..B or A.`);
	const start = parseHashlineAnchor(parts[0], sourceLine);
	const end = parseHashlineAnchor(parts[1], sourceLine);
	if (end.line < start.line) throw new Error(`hashline line ${sourceLine}: range ends before it starts.`);
	return { start, end };
}

function isHashlineTerminator(line: string): boolean {
	if (line === "*** Begin Patch" || line === END_PATCH) return true;
	const first = line[0];
	return first === HASHLINE_FILE_PREFIX || (first !== undefined && HASHLINE_OP_CHARS.includes(first));
}

function collectPayload(lines: string[], start: number): { payload: string[]; next: number } {
	const payload: string[] = [];
	let index = start;
	while (index < lines.length && !isHashlineTerminator(lines[index]!)) payload.push(lines[index++]!);
	return { payload, next: index };
}

function parseHashlineInput(input: string): HashlineOp[] {
	const lines = normalizeText(input).split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	const ops: HashlineOp[] = [];
	let path = "";

	for (let i = 0; i < lines.length;) {
		const line = lines[i]!;
		const sourceLine = i + 1;
		if (!line.trim() || line === "*** Begin Patch") {
			i++;
			continue;
		}
		if (line === END_PATCH) break;
		if (line.startsWith(HASHLINE_FILE_PREFIX)) {
			path = line.slice(HASHLINE_FILE_PREFIX.length).trim();
			if (!path) throw new Error(`hashline line ${sourceLine}: section header requires a path.`);
			i++;
			continue;
		}
		if (!path) throw new Error(`hashline line ${sourceLine}: first non-blank line must be §PATH.`);

		const sigil = line[0];
		const target = line.slice(1).trim();
		if (sigil === HASHLINE_INSERT_AFTER || sigil === HASHLINE_INSERT_BEFORE) {
			if (!target) throw new Error(`hashline line ${sourceLine}: insert op requires an anchor, BOF, or EOF.`);
			const { payload, next } = collectPayload(lines, i + 1);
			if (payload.length === 0) throw new Error(`hashline line ${sourceLine}: insert op requires payload lines.`);
			ops.push({ type: "insert", path, where: sigil === HASHLINE_INSERT_AFTER ? "after" : "before", anchor: parseHashlineCursor(target, sourceLine), payload });
			i = next;
			continue;
		}
		if (sigil === HASHLINE_REPLACE) {
			if (!target) throw new Error(`hashline line ${sourceLine}: replace op requires an anchor range.`);
			const range = parseHashlineRange(target, sourceLine);
			const { payload, next } = collectPayload(lines, i + 1);
			ops.push({ type: "replace", path, ...range, payload });
			i = next;
			continue;
		}
		throw new Error(`hashline line ${sourceLine}: unrecognized op. Use §PATH, »ANCHOR, «ANCHOR, or ≔A..B.`);
	}
	return ops;
}

function validateAnchor(anchor: HashlineAnchor, lines: string[], path: string) {
	if (anchor.line < 1 || anchor.line > lines.length) throw new Error(`hashline ${path}: line ${anchor.line} does not exist; file has ${lines.length} lines.`);
	const actual = computeHashlineHash(anchor.line, lines[anchor.line - 1] ?? "");
	if (actual !== anchor.hash) throw new Error(`hashline ${path}: stale anchor ${anchor.line}${anchor.hash}; current anchor is ${anchor.line}${actual}. Re-read the file and retry.`);
}

function insertIndex(op: Extract<HashlineOp, { type: "insert" }>, lines: string[]): number {
	if (op.anchor === "BOF") return 0;
	if (op.anchor === "EOF") return lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
	validateAnchor(op.anchor, lines, op.path);
	return op.where === "before" ? op.anchor.line - 1 : op.anchor.line;
}

function applyHashlineOpsToText(text: string, ops: HashlineOp[], path: string): { text: string; added: number; removed: number; hunks: number } {
	const lines = text.split("\n");
	const edits: Array<{ index: number; deleteCount: number; payload: string[]; order: number }> = [];

	ops.forEach((op, order) => {
		if (op.path !== path) return;
		if (op.type === "insert") {
			edits.push({ index: insertIndex(op, lines), deleteCount: 0, payload: op.payload, order });
			return;
		}
		validateAnchor(op.start, lines, op.path);
		validateAnchor(op.end, lines, op.path);
		edits.push({ index: op.start.line - 1, deleteCount: op.end.line - op.start.line + 1, payload: op.payload, order });
	});

	let added = 0;
	let removed = 0;
	for (const edit of edits) {
		added += edit.payload.length;
		removed += edit.deleteCount;
	}

	const next = [...lines];
	for (const edit of edits.sort((a, b) => (b.index - a.index) || (b.order - a.order))) next.splice(edit.index, edit.deleteCount, ...edit.payload);
	return { text: next.join("\n"), added, removed, hunks: edits.length };
}

function summarizeHashlineOps(ops: HashlineOp[]): OperationSummary[] {
	const byPath = new Map<string, OperationSummary>();
	for (const op of ops) {
		const summary = byPath.get(op.path) ?? { type: "Update", path: op.path, added: 0, removed: 0, hunks: 0 };
		summary.hunks += 1;
		if (op.type === "insert") summary.added += op.payload.length;
		else {
			summary.added += op.payload.length;
			summary.removed += op.end.line - op.start.line + 1;
		}
		byPath.set(op.path, summary);
	}
	return [...byPath.values()];
}
function buildHashlinePreview(ops: HashlineOp[], cwd: string | undefined): PreviewEntry[] {
	const previews: PreviewEntry[] = [];
	if (!cwd) return previews;
	const grouped = new Map<string, HashlineOp[]>();
	for (const op of ops) grouped.set(op.path, [...(grouped.get(op.path) ?? []), op]);
	for (const [path, pathOps] of grouped) {
		try {
			const filePath = resolvePatchPath(cwd, path);
			const lines = normalizeText(stripBom(readFileSync(filePath, "utf-8")).text).split("\n");
			const output: PreviewLine[] = [];
			for (const op of pathOps) {
				if (op.type === "insert") {
					if (op.anchor !== "BOF" && op.anchor !== "EOF") validateAnchor(op.anchor, lines, op.path);
					for (const line of op.payload) output.push({ kind: "add", text: line });
					continue;
				}
				validateAnchor(op.start, lines, op.path);
				validateAnchor(op.end, lines, op.path);
				for (let line = op.start.line; line <= op.end.line; line++) output.push({ kind: "remove", text: lines[line - 1] ?? "" });
				for (const line of op.payload) output.push({ kind: "add", text: line });
			}
			previews.push({ path, lines: output });
		} catch (error) {
			previews.push({ path, lines: [{ kind: "warning", text: error instanceof Error ? error.message : String(error) }] });
		}
	}
	return previews;
}

function previewMap(entries: PreviewEntry[], theme: ToolTheme): Map<string, string[]> {
	const styleSource = (kind: "add" | "remove", text: string): string => {
		const color = kind === "add" ? "success" : "error";
		const sign = kind === "add" ? "+" : "-";
		const leading = text.match(/^\s*/)?.[0] ?? "";
		const rest = text.slice(leading.length);
		const indent = leading ? theme.fg("dim", leading.replace(/ /g, "·").replace(/\t/g, "→")) : "";
		return `${theme.fg(color, sign)} ${indent}${rest ? theme.fg(color, rest) : ""}`;
	};
	const map = new Map<string, string[]>();
	for (const entry of entries) {
		map.set(entry.path, entry.lines.map((line) => {
			if (line.kind === "add") return styleSource("add", line.text);
			if (line.kind === "remove") return styleSource("remove", line.text);
			return theme.fg("warning", line.text);
		}));
	}
	return map;
}

async function applyHashlineOperations(ops: HashlineOp[], cwd: string, signal?: AbortSignal): Promise<OperationSummary[]> {
	const paths = Array.from(new Set(ops.map((op) => op.path)));
	const prepared: Array<{ path: string; absolutePath: string; after: string; bom: string; ending: "\r\n" | "\n"; summary: OperationSummary }> = [];

	for (const path of paths) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const absolutePath = resolvePatchPath(cwd, path);
		await access(absolutePath, constants.R_OK | constants.W_OK);
		const raw = await readFile(absolutePath, "utf-8");
		const { bom, text } = stripBom(raw);
		const ending = lineEndingOf(text);
		const before = normalizeText(text);
		const applied = applyHashlineOpsToText(before, ops, path);
		if (applied.text === before) throw new Error(`No changes made to ${path}.`);
		prepared.push({ path, absolutePath, after: applied.text, bom, ending, summary: { type: "Update", path, added: applied.added, removed: applied.removed, hunks: applied.hunks } });
	}

	const summaries: OperationSummary[] = [];
	for (const item of prepared) {
		await withFileMutationQueue(item.absolutePath, async () => {
			if (signal?.aborted) throw new Error("Operation aborted");
			await writeFile(item.absolutePath, item.bom + fromLF(item.after, item.ending), "utf-8");
			summaries.push(item.summary);
		});
	}
	return summaries;
}

function formatOperationSummary(op: OperationSummary): string {
	return `[${op.type}] ${op.path} (+${op.added} -${op.removed}, ${op.hunks} hunk${op.hunks === 1 ? "" : "s"})`;
}

function formatToolOutput(summaries: OperationSummary[]): string {
	return summaries.map(formatOperationSummary).join("\n") || "Done!";
}

function textContentFromResult(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content.map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")).filter(Boolean).join("\n");
}

function normalizePreparedArguments(input: unknown): unknown {
	return typeof input === "string" ? { input } : input;
}

function installToolSelection(pi: ExtensionAPI) {
	const active = pi.getActiveTools();
	const next = active.map((name) => (name === "edit" || name === "apply_patch" ? "patch" : name));
	if (!next.includes("patch")) next.push("patch");
	pi.setActiveTools(Array.from(new Set(next)));
}

function renderHashlineSummary(summaries: OperationSummary[], previews: Map<string, string[]>, theme: ToolTheme) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const added = summaries.reduce((sum, item) => sum + item.added, 0);
			const removed = summaries.reduce((sum, item) => sum + item.removed, 0);
			const files = summaries.length || 0;
			const lines = [truncateToWidth(`${theme.fg("dim", "•")} ${theme.fg("toolTitle", theme.bold(files === 1 ? "Edited 1 file" : `Edited ${files} files`))} (${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)})`, width)];
			for (const summary of summaries) {
				lines.push(truncateToWidth(`  ${theme.fg("dim", "└")} ${theme.fg("toolOutput", summary.path)} ${theme.fg("dim", "(")}${theme.fg("success", `+${summary.added}`)} ${theme.fg("error", `-${summary.removed}`)}${theme.fg("dim", ")")}`, width));
				for (const preview of (previews.get(summary.path) ?? []).slice(0, 12)) lines.push(truncateToWidth(`      ${preview}`, width));
			}
			return lines;
		},
	};
}

function renderHashlineCall(args: unknown, theme: ToolTheme, context?: { cwd?: string; state?: Record<string, unknown> }) {
	let summaries: OperationSummary[] = [];
	let previews = new Map<string, string[]>();
	try {
		const input = args && typeof args === "object" ? (args as { input?: unknown }).input : undefined;
		if (typeof input === "string") {
			const ops = parseHashlineInput(input);
			summaries = summarizeHashlineOps(ops);
			const state = context?.state;
			const cached = state?.hashlinePreview instanceof Map ? state.hashlinePreview as Map<string, string[]> : undefined;
			if (cached) {
				previews = cached;
			} else {
				previews = previewMap(buildHashlinePreview(ops, context?.cwd), theme);
				if (state) state.hashlinePreview = previews;
			}
		}
	} catch {
		summaries = [];
	}
	return renderHashlineSummary(summaries, previews, theme);
}

// ── V4A (Codex/OpenAI *** Begin Patch) support ──────────────────────────────

const V4A_END_PATCH = "*** End Patch";
const V4A_END_FILE  = "*** End of File";
const V4A_TERMINATORS = [V4A_END_PATCH, "*** Update File:", "*** Delete File:", "*** Add File:"];
const V4A_SECTION_END = [...V4A_TERMINATORS, V4A_END_FILE];

function v4aNormalize(text: string): string { return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }

function v4aLines(diff: string): string[] {
	const lines = diff.split(/\r?\n/).map(l => l.replace(/\r$/, ""));
	if (lines.length && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function v4aIsDone(lines: string[], idx: number, prefixes: string[]): boolean {
	if (idx >= lines.length) return true;
	return prefixes.some(p => lines[idx]!.startsWith(p));
}

function v4aReadStr(lines: string[], state: { idx: number }, prefix: string): string {
	const cur = lines[state.idx];
	if (typeof cur === "string" && cur.startsWith(prefix)) { state.idx++; return cur.slice(prefix.length); }
	return "";
}

function v4aParseCreateDiff(diff: string): string {
	const lines = [...v4aLines(diff), V4A_END_PATCH];
	const out: string[] = [];
	let i = 0;
	while (i < lines.length && !V4A_TERMINATORS.some(t => lines[i]!.startsWith(t))) {
		const line = lines[i++]!;
		if (!line.startsWith("+")) throw new Error(`V4A: invalid Add File line: ${line}`);
		out.push(line.slice(1));
	}
	return out.join("\n");
}

function v4aEqualsSlice(src: string[], tgt: string[], start: number, mapFn: (s: string) => string): boolean {
	if (start + tgt.length > src.length) return false;
	for (let i = 0; i < tgt.length; i++) if (mapFn(src[start + i]!) !== mapFn(tgt[i]!)) return false;
	return true;
}

function v4aFindContext(lines: string[], ctx: string[], start: number, eof: boolean): { idx: number; fuzz: number } {
	if (!ctx.length) return { idx: start, fuzz: 0 };
	const check = (mapFn: (s: string) => string, fuzz: number) => {
		const startIdx = eof ? Math.max(0, lines.length - ctx.length) : start;
		for (let i = startIdx; i <= lines.length - ctx.length; i++) if (v4aEqualsSlice(lines, ctx, i, mapFn)) return { idx: i, fuzz };
		return null;
	};
	return check(s => s, 0) ?? check(s => s.trimEnd(), 1) ?? check(s => s.trim(), 100) ?? { idx: -1, fuzz: 0 };
}

function v4aReadSection(lines: string[], startIdx: number): { context: string[]; chunks: V4AChunk[]; endIdx: number; eof: boolean } {
	const context: string[] = [];
	let delLines: string[] = [], insLines: string[] = [];
	const chunks: V4AChunk[] = [];
	let mode: "keep" | "add" | "del" = "keep";
	let i = startIdx;
	while (i < lines.length) {
		const raw = lines[i]!;
		if (raw.startsWith("@@") || V4A_SECTION_END.some(t => raw.startsWith(t)) || raw === "***") break;
		if (raw.startsWith("***")) throw new Error(`V4A: invalid line: ${raw}`);
		i++;
		const lastMode = mode;
		let line = raw === "" ? " " : raw;
		if (line[0] === "+") mode = "add";
		else if (line[0] === "-") mode = "del";
		else if (line[0] === " ") mode = "keep";
		else throw new Error(`V4A: invalid diff line: ${line}`);
		line = line.slice(1);
		if (mode === "keep" && lastMode !== mode && (insLines.length || delLines.length)) {
			chunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
			delLines = []; insLines = [];
		}
		if (mode === "del") { delLines.push(line); context.push(line); }
		else if (mode === "add") { insLines.push(line); }
		else { context.push(line); }
	}
	if (insLines.length || delLines.length) chunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
	if (i < lines.length && lines[i] === V4A_END_FILE) return { context, chunks, endIdx: i + 1, eof: true };
	return { context, chunks, endIdx: i, eof: false };
}

function v4aParseUpdateDiff(diff: string, input: string): V4AChunk[] {
	const lines = [...v4aLines(diff), V4A_END_PATCH];
	const inputLines = input.split("\n");
	const allChunks: V4AChunk[] = [];
	let cursor = 0, i = 0, fuzz = 0;
	while (!v4aIsDone(lines, i, V4A_SECTION_END)) {
		const state = { idx: i };
		const anchor = v4aReadStr(lines, state, "@@ ");
		const bare = !anchor && lines[i] === "@@";
		if (bare) state.idx++;
		if (anchor || bare) {
			if (anchor.trim()) {
				for (let j = cursor; j < inputLines.length; j++) {
					if (inputLines[j] === anchor || inputLines[j]!.trim() === anchor.trim()) { cursor = j + 1; break; }
				}
			}
		} else if (cursor !== 0) {
			throw new Error(`V4A: expected @@ anchor`);
		}
		i = state.idx;
		const { context, chunks, endIdx, eof } = v4aReadSection(lines, i);
		const found = v4aFindContext(inputLines, context, cursor, eof);
		if (found.idx === -1) throw new Error(`V4A: context not found:\n${context.join("\n")}`);
		fuzz += found.fuzz;
		for (const ch of chunks) allChunks.push({ ...ch, origIndex: ch.origIndex + found.idx });
		cursor = found.idx + context.length;
		i = endIdx;
	}
	return allChunks;
}

function v4aApplyChunks(input: string, chunks: V4AChunk[]): string {
	const orig = input.split("\n");
	const dest: string[] = [];
	let idx = 0;
	for (const ch of chunks) {
		dest.push(...orig.slice(idx, ch.origIndex));
		dest.push(...ch.insLines);
		idx = ch.origIndex + ch.delLines.length;
	}
	dest.push(...orig.slice(idx));
	return dest.join("\n");
}

function v4aParseOps(patch: string): V4AOp[] {
	const lines = v4aNormalize(patch).split("\n");
	if (lines[0] !== "*** Begin Patch") throw new Error("V4A: must start with '*** Begin Patch'");
	const ops: V4AOp[] = [];
	let i = 1;
	while (i < lines.length) {
		const line = lines[i]!;
		if (line === V4A_END_PATCH) return ops;
		if (line === "") { i++; continue; }
		let m = line.match(/^\*\*\* Add File: (.+)$/);
		if (m) {
			const path = m[1]!.trim();
			const diff = lines.slice(i + 1).join("\n");
			ops.push({ type: "add", path, diff });
			return ops; // add consumes rest
		}
		m = line.match(/^\*\*\* Delete File: (.+)$/);
		if (m) { ops.push({ type: "delete", path: m[1]!.trim() }); i++; continue; }
		m = line.match(/^\*\*\* Update File: (.+)$/);
		if (m) {
			const path = m[1]!.trim();
			let moveTo: string | undefined;
			i++;
			if (lines[i]?.startsWith("*** Move to: ")) { moveTo = lines[i]!.slice("*** Move to: ".length).trim(); i++; }
			const diffLines: string[] = [];
			while (i < lines.length && !lines[i]!.startsWith("*** Update File:") && !lines[i]!.startsWith("*** Delete File:") && !lines[i]!.startsWith("*** Add File:") && lines[i] !== V4A_END_PATCH) {
				diffLines.push(lines[i++]!);
			}
			ops.push({ type: "update", path, diff: diffLines.join("\n"), moveTo });
			continue;
		}
		i++;
	}
	throw new Error("V4A: missing '*** End Patch'");
}

function v4aSummarize(op: V4AOp): OperationSummary {
	if (op.type === "delete") return { type: "Update", path: op.path, added: 0, removed: 0, hunks: 0 };
	const lines = v4aLines(op.diff);
	const added = lines.filter(l => l.startsWith("+")).length;
	const removed = lines.filter(l => l.startsWith("-")).length;
	const hunks = Math.max(1, lines.filter(l => l.startsWith("@@")).length);
	return { type: "Update", path: op.path, added, removed, hunks };
}

function buildV4APreview(ops: V4AOp[], cwd: string | undefined): PreviewEntry[] {
	const previews: PreviewEntry[] = [];
	for (const op of ops) {
		const lines: PreviewLine[] = [];
		try {
			if (op.type === "add") {
				for (const line of v4aParseCreateDiff(op.diff).split("\n")) lines.push({ kind: "add", text: line });
			} else if (op.type === "delete") {
				if (!cwd) throw new Error("cwd unavailable for delete preview");
				const raw = readFileSync(resolvePatchPath(cwd, op.path), "utf-8");
				for (const line of normalizeText(stripBom(raw).text).split("\n")) lines.push({ kind: "remove", text: line });
			} else {
				for (const line of v4aLines(op.diff)) {
					if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
					if (line.startsWith("+")) lines.push({ kind: "add", text: line.slice(1) });
					else if (line.startsWith("-")) lines.push({ kind: "remove", text: line.slice(1) });
				}
			}
		} catch (error) {
			lines.push({ kind: "warning", text: error instanceof Error ? error.message : String(error) });
		}
		previews.push({ path: op.moveTo ?? op.path, lines });
	}
	return previews;
}

async function applyV4AOps(ops: V4AOp[], cwd: string, signal?: AbortSignal): Promise<OperationSummary[]> {
	const summaries: OperationSummary[] = [];
	for (const op of ops) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const absolutePath = resolvePatchPath(cwd, op.path);
		await withFileMutationQueue(absolutePath, async () => {
			if (op.type === "add") {
				const content = v4aParseCreateDiff(op.diff);
				await (await import("node:fs/promises")).mkdir(dirname(absolutePath), { recursive: true });
				await writeFile(absolutePath, content, "utf-8");
			} else if (op.type === "delete") {
				await (await import("node:fs/promises")).rm(absolutePath);
			} else {
				await access(absolutePath, constants.R_OK | constants.W_OK);
				const raw = await readFile(absolutePath, "utf-8");
				const { bom, text } = stripBom(raw);
				const ending = lineEndingOf(text);
				const before = v4aNormalize(text);
				const chunks = v4aParseUpdateDiff(op.diff, before);
				const after = v4aApplyChunks(before, chunks);
				if (after === before && !op.moveTo) throw new Error(`No changes made to ${op.path}.`);
				const dest = op.moveTo ? resolvePatchPath(cwd, op.moveTo) : absolutePath;
				await (await import("node:fs/promises")).mkdir(dirname(dest), { recursive: true });
				await writeFile(dest, bom + (ending === "\r\n" ? after.replace(/\n/g, "\r\n") : after), "utf-8");
				if (op.moveTo && dest !== absolutePath) await (await import("node:fs/promises")).rm(absolutePath);
			}
			summaries.push(v4aSummarize(op));
		});
	}
	return summaries;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "patch",
		label: "patch",
		description: "Edit files with V4A patch format. Use { patch } starting with *** Begin Patch and ending with *** End Patch.",
		promptSnippet: "Edit files with V4A patch format",
		promptGuidelines: [
			"Use patch for file edits instead of edit or apply_patch.",
			"Call patch with { patch } using V4A format: start with '*** Begin Patch', then '*** Add File:', '*** Update File:', or '*** Delete File:' sections, end with '*** End Patch'. Use @@ context lines, - remove, + add.",
			"Multiple sections are allowed in one input. Do not call patch in parallel with other tools.",
		],
		parameters: Type.Object(
			{
				patch: Type.String({ description: "V4A patch text. Must start with '*** Begin Patch' and end with '*** End Patch'." }),
			},
			{ additionalProperties: false },
		),
		prepareArguments(raw) {
			return typeof raw === "string" ? { patch: raw } : raw;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as { patch?: string };
			if (typeof p.patch !== "string" || !p.patch.trim()) throw new Error("V4A patch required: provide { patch } starting with *** Begin Patch.");
			const ops = v4aParseOps(p.patch);
			if (ops.length === 0) throw new Error("V4A patch: no file operations found.");
			const preview = buildV4APreview(ops, ctx.cwd);
			const summaries = await applyV4AOps(ops, ctx.cwd, signal);
			return { content: [{ type: "text", text: formatToolOutput(summaries) }], details: { operations: summaries, mode: "v4a", preview } };
		},
		renderCall(args, theme, context) {
			const a = args as { patch?: string; input?: string };
			if (typeof a.patch === "string") {
				let summaries: OperationSummary[] = [];
				let preview: PreviewEntry[] = [];
				try {
					const ops = v4aParseOps(a.patch);
					summaries = ops.map(v4aSummarize);
					preview = buildV4APreview(ops, context?.cwd);
				} catch {}
				return renderHashlineSummary(summaries, previewMap(preview, theme), theme);
			}
			return renderHashlineCall(args, theme, context);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				text.setText(theme.fg("error", `patch failed\n${textContentFromResult(result) || "patch failed"}`));
				return text;
			}
			const component = context.lastComponent ?? new Container();
			component.clear();
			return component;
		},
	});

	pi.on("session_start", async () => {
		installToolSelection(pi);
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "edit" || event.toolName === "apply_patch") return { block: true, reason: "edit/apply_patch are disabled by the patch extension. Use patch instead." };
	});

}
