import { readFileSync, statSync } from "node:fs";

export type ActiveUploadProvider = "xvideos" | "porntrex";
export interface UploadProvidersFile {
    version: 1;
    // Ignored: the active destination lives in the pipeline database.
    activeProvider?: unknown;
    providers: Partial<Record<ActiveUploadProvider, { email?: string; username?: string; password: string }>>;
}

export function assertUploadProvider(value: unknown): asserts value is ActiveUploadProvider {
    if (value !== "xvideos" && value !== "porntrex") throw new Error("Upload provider must be xvideos or porntrex");
}

export function readUploadProvidersFile(filePath: string): UploadProvidersFile {
    const info = statSync(filePath);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Upload provider credentials must be a private file (chmod 600)");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(filePath, "utf8")); } catch {
        // JSON parser diagnostics may include the actual secret. Never expose them.
        throw new Error("Upload provider credentials file is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid upload provider configuration");
    const config = parsed as UploadProvidersFile;
    if (config.version !== 1 || !config.providers || typeof config.providers !== "object") {
        throw new Error("Upload provider configuration requires version 1 and providers");
    }
    return config;
}

export function readProviderCredentials(filePath: string, provider: ActiveUploadProvider): { email: string; password: string } {
    assertUploadProvider(provider);
    const entry = readUploadProvidersFile(filePath).providers[provider];
    const email = entry?.email ?? entry?.username;
    if (typeof email !== "string" || !email.trim() || typeof entry?.password !== "string" || !entry.password) {
        throw new Error(`${provider} username/email and password are missing from the configured credentials file`);
    }
    return { email: email.trim(), password: entry.password };
}
