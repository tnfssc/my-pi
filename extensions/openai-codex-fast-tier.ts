import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, createAssistantMessageEventStream, streamOpenAICodexResponses } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

const FAST_CODEX_MODEL_MAP: Record<string, string> = {
	"gpt-5.4-fast": "gpt-5.4",
	"gpt-5.5-fast": "gpt-5.5",
};

function rewriteMessageModel(message: AssistantMessage, aliasModelId: string): AssistantMessage {
	message.model = aliasModelId;
	return message;
}

function rewriteEventModel(event: AssistantMessageEvent, aliasModelId: string): AssistantMessageEvent {
	if ("partial" in event) rewriteMessageModel(event.partial, aliasModelId);
	if (event.type === "done") rewriteMessageModel(event.message, aliasModelId);
	if (event.type === "error") rewriteMessageModel(event.error, aliasModelId);
	return event;
}

function streamFastCodexAlias(
	model: Model<any>,
	context: Parameters<typeof streamOpenAICodexResponses>[1],
	options?: SimpleStreamOptions,
) {
	const baseModelId = FAST_CODEX_MODEL_MAP[model.id];
	const requestModel = baseModelId ? { ...model, id: baseModelId } : model;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(requestModel, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const inner = streamOpenAICodexResponses(requestModel as Model<"openai-codex-responses">, context, {
		...options,
		reasoningEffort,
		serviceTier: baseModelId ? "priority" : undefined,
	});

	if (!baseModelId) return inner;

	const outer = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner) {
				outer.push(rewriteEventModel(event, model.id));
			}
		} catch (error) {
			outer.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
		} finally {
			outer.end();
		}
	})();
	return outer;
}

export default function openAICodexFastTier(pi: ExtensionAPI) {
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: streamFastCodexAlias,
	});

	pi.on("before_provider_request", (event) => {
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

		const body = payload as { model?: unknown; service_tier?: unknown };
		if (typeof body.model !== "string") return undefined;

		const baseModel = FAST_CODEX_MODEL_MAP[body.model];
		if (!baseModel) return undefined;

		return {
			...body,
			model: baseModel,
			service_tier: body.service_tier ?? "priority",
		};
	});
}
