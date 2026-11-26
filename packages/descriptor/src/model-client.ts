import http from "node:http";
import https from "node:https";
import { descriptorConfig } from "./config.js";

export interface DescriptionResult {
    title: string;
    description: string;
    tags?: string[];
}

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    timings?: Record<string, unknown>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.DESCRIPTOR_REQUEST_TIMEOUT_MS ?? String(25 * 60_000), 10);

export function postJson(url: URL, body: unknown, timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS): Promise<{ status: number; body: ChatCompletionResponse }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const transport = url.protocol === "https:" ? https : http;
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn();
        };
        const request = transport.request(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        }, (response) => {
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => { responseBody += chunk; });
            response.on("error", (error) => finish(() => reject(error)));
            response.on("aborted", () => finish(() => reject(new Error("Model response was interrupted"))));
            response.on("end", () => {
                try {
                    const parsed = JSON.parse(responseBody) as ChatCompletionResponse;
                    finish(() => resolve({
                        status: response.statusCode ?? 0,
                        body: parsed,
                    }));
                } catch (error) {
                    finish(() => reject(new Error(`Model returned invalid JSON: ${responseBody.slice(0, 500)}`, { cause: error })));
                }
            });
        });
        const timer = Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0
            ? setTimeout(() => {
                request.destroy(new Error(`Model request timed out after ${Math.round(timeoutMilliseconds / 1000)}s`));
            }, timeoutMilliseconds)
            : null;
        timer?.unref?.();
        request.on("error", (error) => finish(() => reject(error)));
        request.end(payload);
    });
}

// The JSON the model must answer with, bounded by the content profile.
export function descriptionResponseFormat() {
    const bounds = descriptorConfig.output;
    return {
        type: "json_object",
        schema: {
            type: "object",
            additionalProperties: false,
            required: ["title", "description"],
            properties: {
                title: { type: "string", minLength: bounds.titleMinLength, maxLength: bounds.titleMaxLength },
                description: { type: "string", minLength: bounds.descriptionMinLength, maxLength: bounds.descriptionMaxLength },
            },
        },
    };
}

export async function requestDescription(videoUrl: string, fps: number, prompt: string) {
    const response = await postJson(new URL("/v1/chat/completions", descriptorConfig.modelUrl), {
        model: descriptorConfig.requestModel,
        messages: [{
            role: "user",
            content: [
                { type: "input_video", input_video: { url: videoUrl, fps } },
                { type: "text", text: prompt },
            ],
        }],
        temperature: 0.2,
        max_tokens: 512,
        cache_prompt: false,
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
        response_format: descriptionResponseFormat(),
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Model request failed (${response.status}): ${response.body.error?.message ?? JSON.stringify(response.body)}`);
    }
    const content = response.body.choices?.[0]?.message?.content;
    if (!content) throw new Error(`Model returned no message content: ${JSON.stringify(response.body)}`);
    return {
        description: JSON.parse(content) as DescriptionResult,
        usage: response.body.usage,
        timings: response.body.timings,
        raw: response.body,
    };
}
