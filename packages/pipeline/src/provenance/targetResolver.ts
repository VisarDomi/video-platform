import https from "node:https";
import path from "node:path";
import { extractRecordingIdentifier, streamerSourceLinks, type StreamProvider } from "shared";
import type { RecordingInput, RecordingProvenance } from "../domain/types.js";

// Recording provenance is resolved by the SERVER's own per-provider capability
// (GET /api/{provider}/resolve): the Tango alias registry + live Tango API,
// FC2 numeric IDs, and the Stripchat username lookup. The pipeline keeps no
// catalog-matching logic of its own.

export interface TargetResolverConfig {
    readonly serverUrl?: string;
    readonly resolveIdentifier?: (
        provider: StreamProvider,
        identifier: string,
    ) => Promise<{ id: string; label: string } | null>;
}

export type ProviderIdentifierResolver = (
    provider: StreamProvider,
    identifier: string,
) => Promise<{ id: string; label: string } | null>;

// The API server serves HTTPS with a local mkcert certificate, so the
// client accepts the local certificate instead of failing TLS verification.
function defaultServerResolver(serverUrl: string): ProviderIdentifierResolver {
    return (provider, identifier) => new Promise((resolve) => {
        const url = new URL(`${serverUrl}/api/${provider}/resolve?identifier=${encodeURIComponent(identifier)}`);
        const request = https.request({
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            rejectUnauthorized: false,
            timeout: 15_000,
        }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => { body += chunk; });
            response.on("end", () => {
                if (response.statusCode !== 200) return resolve(null);
                try {
                    const parsed = JSON.parse(body) as { id?: unknown; label?: unknown };
                    if (typeof parsed.id === "string" && typeof parsed.label === "string") {
                        resolve({ id: parsed.id, label: parsed.label });
                    } else {
                        resolve(null);
                    }
                } catch {
                    resolve(null);
                }
            });
        });
        request.on("error", () => resolve(null));
        request.on("timeout", () => { request.destroy(); resolve(null); });
        request.end();
    });
}

function isProvider(value: string): value is StreamProvider {
    return value === "tango" || value === "fc2" || value === "sc";
}

export class TargetCatalogResolver {
    private constructor(private readonly resolveIdentifier: ProviderIdentifierResolver) {}

    static load(config: TargetResolverConfig): TargetCatalogResolver {
        return new TargetCatalogResolver(
            config.resolveIdentifier
                ?? defaultServerResolver(config.serverUrl ?? "http://127.0.0.1:7973"),
        );
    }

    async resolve(
        recording: RecordingInput,
        now = new Date(),
    ): Promise<Omit<RecordingProvenance, "recordingId">> {
        const observedIdentifier = extractRecordingIdentifier(path.basename(recording.sourcePath));
        const timestamp = now.toISOString();
        if (!isProvider(recording.provider)) {
            return {
                observedIdentifier,
                status: "review_required",
                streamerId: null,
                alias: null,
                streamerUrl: null,
                aliasUrl: null,
                reason: `unsupported_provider:${recording.provider}`,
                updatedAt: timestamp,
            };
        }
        const resolved = await this.resolveIdentifier(recording.provider, observedIdentifier);
        if (!resolved) {
            return {
                observedIdentifier,
                status: "review_required",
                streamerId: null,
                alias: null,
                streamerUrl: null,
                aliasUrl: null,
                reason: "identifier_not_resolved_by_server",
                updatedAt: timestamp,
            };
        }
        const links = streamerSourceLinks({
            provider: recording.provider,
            id: resolved.id,
            label: resolved.label,
        });
        return {
            observedIdentifier,
            status: "resolved",
            streamerId: resolved.id,
            alias: resolved.label,
            streamerUrl: links.streamerUrl,
            aliasUrl: links.aliasUrl,
            reason: null,
            updatedAt: timestamp,
        };
    }
}
