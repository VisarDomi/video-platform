import { descriptorConfig } from "./config.js";
import { LlamaServer } from "./llama-server.js";
import { postJson } from "./model-client.js";

export interface DescriptionText {
    readonly title: string;
    readonly description: string;
}

export function rewritePrompt(text: DescriptionText, phrases: readonly string[]): string {
    return `Rewrite this video title and description so that none of these phrases appears anywhere in either, `
        + `not even inside a longer word (for example "ambient" contains "ambien"): ${phrases.map((phrase) => JSON.stringify(phrase)).join(", ")}.\n`
        + `Change only the words that must change, keep every fact and the tone, and keep about the same length.\n\n`
        + `Title: ${text.title}\nDescription: ${text.description}`;
}

// Text only, no video: the same local model fixes a title/description that a
// provider would reject, in seconds instead of describing the video again.
// The caller re-checks the result and falls back to a full re-description.
export async function rewriteAvoidingPhrases(
    text: DescriptionText,
    phrases: readonly string[],
    options: { server?: LlamaServer; manageServer?: boolean } = {},
): Promise<DescriptionText> {
    const server = options.server ?? new LlamaServer();
    const manageServer = options.manageServer ?? true;
    try {
        if (manageServer) await server.start();
        const response = await postJson(new URL("/v1/chat/completions", descriptorConfig.modelUrl), {
            model: "gemma-4-E4B-it-OBLITERATED-Q8_0",
            messages: [{ role: "user", content: [{ type: "text", text: rewritePrompt(text, phrases) }] }],
            temperature: 0.2,
            max_tokens: 512,
            reasoning_effort: "none",
            chat_template_kwargs: { enable_thinking: false },
            response_format: {
                type: "json_object",
                schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["title", "description"],
                    properties: {
                        title: { type: "string", minLength: 5, maxLength: 100 },
                        description: { type: "string", minLength: 20, maxLength: 750 },
                    },
                },
            },
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Rewrite request failed (${response.status}): ${response.body.error?.message ?? "no detail"}`);
        }
        const content = response.body.choices?.[0]?.message?.content;
        if (!content) throw new Error("Rewrite returned no message content");
        const parsed = JSON.parse(content) as Partial<DescriptionText>;
        if (typeof parsed.title !== "string" || typeof parsed.description !== "string") throw new Error("Rewrite returned no title/description");
        return { title: parsed.title.trim(), description: parsed.description.trim() };
    } finally {
        if (manageServer) await server.stop();
    }
}
