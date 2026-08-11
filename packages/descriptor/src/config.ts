import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
const modelDirectory = path.join(dataRoot, "models", "gemma-4-e4b-obliterated");

export const descriptorConfig = {
    packageDirectory,
    dataRoot,
    evidenceDirectory: path.join(dataRoot, "descriptor-smoke"),
    mediaDirectory: process.env.DESCRIPTOR_MEDIA_PATH ?? path.join(dataRoot, "descriptor-media"),
    promptPath: process.env.DESCRIPTOR_PROMPT_PATH
        ?? path.join(packageDirectory, "prompts", "video-description.txt"),
    runtimeExecutable: process.env.DESCRIPTOR_LLAMA_SERVER
        ?? path.join(dataRoot, "runtimes", "llama-cpp", "current", "bin", "llama-server"),
    modelPath: process.env.DESCRIPTOR_MODEL_PATH
        ?? path.join(modelDirectory, "gemma-4-E4B-OBLITERATED-Q8_0.gguf"),
    projectorPath: process.env.DESCRIPTOR_MMPROJ_PATH
        ?? path.join(modelDirectory, "mmproj-gemma-4-E4B-OBLITERATED-F16.gguf"),
    templatePath: process.env.DESCRIPTOR_TEMPLATE_PATH
        ?? path.join(packageDirectory, "gemma4-direct.jinja"),
    modelUrl: process.env.DESCRIPTOR_MODEL_URL ?? "http://127.0.0.1:7976",
    useExternalServer: process.env.DESCRIPTOR_MODEL_URL !== undefined,
    port: Number.parseInt(process.env.DESCRIPTOR_MODEL_PORT ?? "7976", 10),
    contextTokens: 131_072,
    videoTokenBudget: Number.parseInt(process.env.DESCRIPTOR_VIDEO_TOKEN_BUDGET ?? "115000", 10),
    tokensPerFrame: Number.parseFloat(process.env.DESCRIPTOR_TOKENS_PER_FRAME ?? "70.5"),
    maximumFps: Number.parseFloat(process.env.DESCRIPTOR_MAX_FPS ?? "4"),
};
