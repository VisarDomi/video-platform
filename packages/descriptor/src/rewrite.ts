import { descriptorConfig } from "./config.js";
import { LlamaServer } from "./llama-server.js";
import { descriptionResponseFormat, postJson } from "./model-client.js";

export interface DescriptionText {
    readonly title: string;
    readonly description: string;
}

export function rewritePrompt(text: DescriptionText, phrases: readonly string[]): string {
    return `Rewrite this video title and description so that none of these phrases appears anywhere in either, `
        + `not even inside a longer word (for example "surface" contains "ace"): ${phrases.map((phrase) => JSON.stringify(phrase)).join(", ")}.\n`
        + `Change only the words that must change, keep every fact and the tone, and keep about the same length.\n\n`
        + `Title: ${text.title}\nDescription: ${text.description}`;
}

// Text only, no video: the same local model fixes a title/description that a
// provider would reject, in seconds instead of describing the video again.
// The caller re-checks the result and falls back to a full re-description.
export async function rewriteAvoidingPhrases(
    text: DescriptionText,
    phrases: readonly string[],
    // Like a description, the managed server is started for this call and stopped after it,
    // or when the signal aborts.
    options: { server?: LlamaServer; manageServer?: boolean; signal?: AbortSignal } = {},
): Promise<DescriptionText> {
    const server = options.server ?? new LlamaServer();
    const manageServer = options.manageServer ?? true;
    const release = manageServer ? server.stopWhenAborted(options.signal) : () => undefined;
    try {
        options.signal?.throwIfAborted();
        if (manageServer) await server.start();
        const request = () => postJson(new URL("/v1/chat/completions", descriptorConfig.modelUrl), {
            model: descriptorConfig.requestModel,
            messages: [{ role: "user", content: [{ type: "text", text: rewritePrompt(text, phrases) }] }],
            temperature: 0.2,
            max_tokens: 512,
            reasoning_effort: "none",
            chat_template_kwargs: { enable_thinking: false },
            response_format: descriptionResponseFormat(),
        });
        const response = await (manageServer ? server.requestWithRecovery(request) : request());
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Rewrite request failed (${response.status}): ${response.body.error?.message ?? "no detail"}`);
        }
        const content = response.body.choices?.[0]?.message?.content;
        if (!content) throw new Error("Rewrite returned no message content");
        const parsed = JSON.parse(content) as Partial<DescriptionText>;
        if (typeof parsed.title !== "string" || typeof parsed.description !== "string") throw new Error("Rewrite returned no title/description");
        return { title: parsed.title.trim(), description: parsed.description.trim() };
    } finally {
        release();
        if (manageServer) await server.stop();
    }
}
