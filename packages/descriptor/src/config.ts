import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = process.env.VIDEO_SERVICES_DATA_ROOT
    ?? path.join(os.homedir(), ".local", "share", "video-services");
const modelsDirectory = path.join(dataRoot, "models");

// What the deployment's content profile decides: the prompt, the model and the output
// bounds (the sdk's DescriptorSettings). The host configures it once at start-up.
export interface DescriptorProfileSettings {
    promptFile: string;
    modelFile: string;
    projectorFile: string;
    requestModel: string;
    output: { titleMinLength: number; titleMaxLength: number; descriptionMinLength: number; descriptionMaxLength: number };
}

let profileSettings: DescriptorProfileSettings | null = null;

export function configureDescriptor(settings: DescriptorProfileSettings): void {
    profileSettings = settings;
}

function profile(): DescriptorProfileSettings {
    if (!profileSettings) throw new Error("The descriptor has no content profile: the host must call configureDescriptor() first");
    return profileSettings;
}

// The profile gives the defaults; an environment variable, or a value assigned to the
// property, overrides them.
const overrides: {
    promptPath?: string; modelPath?: string; projectorPath?: string;
    requestModel?: string; output?: DescriptorProfileSettings["output"];
} = {
    ...(process.env.DESCRIPTOR_PROMPT_PATH ? { promptPath: process.env.DESCRIPTOR_PROMPT_PATH } : {}),
    ...(process.env.DESCRIPTOR_MODEL_PATH ? { modelPath: process.env.DESCRIPTOR_MODEL_PATH } : {}),
    ...(process.env.DESCRIPTOR_MMPROJ_PATH ? { projectorPath: process.env.DESCRIPTOR_MMPROJ_PATH } : {}),
};

export const descriptorConfig = {
    packageDirectory,
    dataRoot,
    // The deployment's sites file, which names its content profile.
    sitesFile: process.env.VIDEO_SITES_FILE ?? path.join(dataRoot, "sites.json"),
    evidenceDirectory: path.join(dataRoot, "pipeline", "descriptions"),
    mediaDirectory: process.env.DESCRIPTOR_MEDIA_PATH ?? path.join(dataRoot, "descriptor-media"),
    get promptPath(): string { return overrides.promptPath ?? profile().promptFile; },
    set promptPath(value: string) { overrides.promptPath = value; },
    runtimeExecutable: process.env.DESCRIPTOR_LLAMA_SERVER
        ?? path.join(dataRoot, "runtimes", "llama-cpp", "current", "bin", "llama-server"),
    get modelPath(): string { return overrides.modelPath ?? path.resolve(modelsDirectory, profile().modelFile); },
    set modelPath(value: string) { overrides.modelPath = value; },
    get projectorPath(): string { return overrides.projectorPath ?? path.resolve(modelsDirectory, profile().projectorFile); },
    set projectorPath(value: string) { overrides.projectorPath = value; },
    get requestModel(): string { return overrides.requestModel ?? profile().requestModel; },
    set requestModel(value: string) { overrides.requestModel = value; },
    get output(): DescriptorProfileSettings["output"] { return overrides.output ?? profile().output; },
    set output(value: DescriptorProfileSettings["output"]) { overrides.output = value; },
    templatePath: process.env.DESCRIPTOR_TEMPLATE_PATH
        ?? path.join(packageDirectory, "gemma4-direct.jinja"),
    modelUrl: process.env.DESCRIPTOR_MODEL_URL ?? "http://127.0.0.1:7976",
    useExternalServer: process.env.DESCRIPTOR_MODEL_URL !== undefined,
    port: Number.parseInt(process.env.DESCRIPTOR_MODEL_PORT ?? "7976", 10),
    startupTimeoutMilliseconds: Number.parseInt(process.env.DESCRIPTOR_STARTUP_TIMEOUT_MS ?? "600000", 10),
    healthRequestTimeoutMilliseconds: 2000,
    contextTokens: 131_072,
    videoTokenBudget: Number.parseInt(process.env.DESCRIPTOR_VIDEO_TOKEN_BUDGET ?? "115000", 10),
    tokensPerFrame: Number.parseFloat(process.env.DESCRIPTOR_TOKENS_PER_FRAME ?? "70.5"),
    maximumFps: Number.parseFloat(process.env.DESCRIPTOR_MAX_FPS ?? "4"),
};
