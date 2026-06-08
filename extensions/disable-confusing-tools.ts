import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOLS = new Set(["ctx_shell"]);

function filterTools(pi: ExtensionAPI): void {
	const activeTools = pi.getActiveTools();
	const filteredTools = activeTools.filter((toolName) => !DISABLED_TOOLS.has(toolName));
	if (filteredTools.length !== activeTools.length) {
		pi.setActiveTools(filteredTools);
	}
}

export default function disableConfusingTools(pi: ExtensionAPI) {
	pi.on("session_start", () => filterTools(pi));
	pi.on("model_select", () => filterTools(pi));
}
