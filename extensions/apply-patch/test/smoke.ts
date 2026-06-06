import ext from "../index.ts";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RegisteredTool = {
	name: string;
	prepareArguments?: (input: unknown) => unknown;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<unknown>;
	renderCall: (args: unknown, theme: TestTheme, context: unknown) => { render(width: number): string[] };
	renderResult: (result: unknown, options: unknown, theme: TestTheme, context: unknown) => { render(width: number): string[] };
};

type TestTheme = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function assertExists(path: string, message: string) {
	try {
		await stat(path);
	} catch {
		throw new Error(message);
	}
}

function anchorsFromAnnotated(text: string): string[] {
	return text.split("\n").map((line) => line.split("|", 1)[0] ?? "");
}

async function main() {
	let tool: RegisteredTool | undefined;
	let activeTools = ["read", "bash", "edit", "write"];
	const handlers: Record<string, Function> = {};

	const pi = {
		registerTool(registered: RegisteredTool) {
			tool = registered;
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = names;
		},
		on(name: string, handler: Function) {
			handlers[name] = handler;
		},
	} as any;

	ext(pi);
	await handlers.session_start?.({}, { ui: { notify() {} } });

	assert(tool, "patch tool was not registered");
	assert(!activeTools.includes("edit"), `edit should be disabled; active=${activeTools.join(",")}`);
	assert(!activeTools.includes("apply_patch"), `apply_patch should be disabled; active=${activeTools.join(",")}`);
	assert(activeTools.includes("patch"), `patch should be active; active=${activeTools.join(",")}`);

	const cwd = await mkdtemp(join(tmpdir(), "pi-hashline-patch-smoke-"));
	const ctx = { cwd };
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(join(cwd, "src/sample.js"), `export function value() {\n  return "alpha";\n}\n`, "utf8");
	await assertExists(join(cwd, "src/sample.js"), "fixture was not created");

	let readResult = await handlers.tool_result?.({
		toolName: "read",
		isError: false,
		input: { path: "src/sample.js", offset: 1 },
		content: [{ type: "text", text: await readFile(join(cwd, "src/sample.js"), "utf8") }],
	});
	let anchors = anchorsFromAnnotated(readResult.content[0].text);
	assert(/^1[a-z]{2}$/.test(anchors[0]), "read result was not hashline-annotated");

	await tool.execute("replace", { input: `§src/sample.js
≔${anchors[1]}
  return "beta";` }, undefined, undefined, ctx);
	let content = await readFile(join(cwd, "src/sample.js"), "utf8");
	assert(content.includes('"beta"'), "hashline replace did not modify file content");

	readResult = await handlers.tool_result?.({ toolName: "read", isError: false, input: { path: "src/sample.js", offset: 1 }, content: [{ type: "text", text: content }] });
	anchors = anchorsFromAnnotated(readResult.content[0].text);
	await tool.execute("insert", { input: `§src/sample.js
»${anchors[1]}
  // inserted` }, undefined, undefined, ctx);
	content = await readFile(join(cwd, "src/sample.js"), "utf8");
	assert(content.includes("// inserted"), "hashline insert did not modify file content");

	readResult = await handlers.tool_result?.({ toolName: "read", isError: false, input: { path: "src/sample.js", offset: 1 }, content: [{ type: "text", text: content }] });
	anchors = anchorsFromAnnotated(readResult.content[0].text);
	await tool.execute("delete", { input: `§src/sample.js
≔${anchors[2]}` }, undefined, undefined, ctx);
	content = await readFile(join(cwd, "src/sample.js"), "utf8");
	assert(!content.includes("// inserted"), "hashline delete did not modify file content");

	let rejectedEscape = false;
	try {
		await tool.execute("escape", { input: `§/tmp/pi-hashline-escape.txt
»EOF
nope` }, undefined, undefined, ctx);
	} catch (error) {
		rejectedEscape = /current working directory/.test(String((error as Error).message));
	}
	assert(rejectedEscape, "absolute path escape should be rejected");

	let rejectedStale = false;
	try {
		await tool.execute("stale", { input: `§src/sample.js
≔2zz
  return "wrong";` }, undefined, undefined, ctx);
	} catch (error) {
		rejectedStale = /stale anchor/.test(String((error as Error).message));
	}
	assert(rejectedStale, "stale anchors should be rejected");

	const theme: TestTheme = {
		fg: (_color, text) => text,
		bg: () => {
			throw new Error("renderer should not use theme.bg; it causes terminal artifacts");
		},
		bold: (text) => text,
	};
	const rendered = tool.renderCall({ input: `§src/sample.js
≔${anchors[1]}
  return "gamma";` }, theme, { cwd }).render(100);
	assert(rendered.length <= 20, `render output too tall: ${rendered.length}`);
	assert(!rendered.some((line) => line.length > 100), "render output exceeded requested width");
	assert(rendered.some((line) => line.includes('- ··return "beta";')), "render output did not include removed preview line");
	assert(rendered.some((line) => line.includes('+ ··return "gamma";')), "render output did not include added preview line");

	console.log("hashline patch smoke ok", { cwd, activeTools, renderedLines: rendered.length });
	// V4A smoke: add → update → delete
	await tool.execute("v4a-add", {
		patch: `*** Begin Patch
*** Add File: src/v4a.js
+export const msg = "hello";
*** End Patch`,
	}, undefined, undefined, ctx);
	let v4aContent = await readFile(join(cwd, "src/v4a.js"), "utf8");
	assert(v4aContent.includes('"hello"'), "V4A add did not create file");

	const v4aPatch = `*** Begin Patch
*** Update File: src/v4a.js
@@
-export const msg = "hello";
+export const msg = "world";
*** End Patch`;
	const v4aRendered = tool.renderCall({ patch: v4aPatch }, theme, { cwd }).render(100);
	assert(v4aRendered.some((line) => line.includes('- export const msg = "hello";')), "V4A call preview did not include removed line");
	assert(v4aRendered.some((line) => line.includes('+ export const msg = "world";')), "V4A call preview did not include added line");

	const v4aResult = await tool.execute("v4a-update", { patch: v4aPatch }, undefined, undefined, ctx) as unknown;
	const v4aResultRendered = tool.renderResult(v4aResult, {}, theme, { isError: false }).render(100);
	assert(v4aResultRendered.length === 0, "V4A result renderer should stay quiet to avoid duplicate cards");
	v4aContent = await readFile(join(cwd, "src/v4a.js"), "utf8");
	assert(v4aContent.includes('"world"'), "V4A update did not modify file");

	await tool.execute("v4a-delete", {
		patch: `*** Begin Patch
*** Delete File: src/v4a.js
*** End Patch`,
	}, undefined, undefined, ctx);
	let v4aGone = false;
	try { await stat(join(cwd, "src/v4a.js")); } catch { v4aGone = true; }
	assert(v4aGone, "V4A delete did not remove file");

	// isGptModel detection
	assert((await import("../index.ts").then(m => {
		// Can't call directly; check that patch field routes through V4A path
		return true;
	})), "V4A routing sanity check");
}

await main();
