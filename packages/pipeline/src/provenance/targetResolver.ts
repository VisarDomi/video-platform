import https from "node:https";
import path from "node:path";
import { extractRecordingIdentifier } from "shared";
import type { RecordingInput, RecordingProvenance } from "../domain/types.js";

// Recording provenance is resolved by the SERVER, through each site's catalog
// (GET /api/{site}/resolve): the identity of the channel a recording's folder names, and
// the site's pages for it (the catalog's sourceLinks). The pipeline keeps no
// catalog-matching logic and no site addresses of its own.

// One resolution: the channel's ID and label and, from a site whose catalog has them,
// its pages (channelUrl; aliasUrl when the label is a name of its own).
export interface ResolvedTarget {
    readonly id: string;
    readonly label: string;
    readonly channelUrl?: string;
    readonly aliasUrl?: string | null;
}

export interface TargetResolverConfig {
    readonly serverUrl?: string;
    readonly resolveIdentifier?: ProviderIdentifierResolver;
}

export type ProviderIdentifierResolver = (
    provider: string,
    identifier: string,
) => Promise<ResolvedTarget | null>;

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
                    const parsed = JSON.parse(body) as { id?: unknown; label?: unknown; channelUrl?: unknown; aliasUrl?: unknown };
                    if (typeof parsed.id === "string" && typeof parsed.label === "string") {
                        resolve({
                            id: parsed.id, label: parsed.label,
                            ...(typeof parsed.channelUrl === "string" ? { channelUrl: parsed.channelUrl } : {}),
                            ...(typeof parsed.aliasUrl === "string" || parsed.aliasUrl === null ? { aliasUrl: parsed.aliasUrl } : {}),
                        });
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

export class TargetCatalogResolver {
    private constructor(private readonly resolveIdentifier: ProviderIdentifierResolver) {}

    static load(config: TargetResolverConfig): TargetCatalogResolver {
        return new TargetCatalogResolver(
            config.resolveIdentifier
                ?? defaultServerResolver(config.serverUrl ?? "http://127.0.0.1:9999"),
        );
    }

    async resolve(
        recording: RecordingInput,
        now = new Date(),
    ): Promise<Omit<RecordingProvenance, "recordingId">> {
        const observedIdentifier = extractRecordingIdentifier(path.basename(recording.sourcePath));
        const timestamp = now.toISOString();
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
        // A site whose catalog gives no pages leaves the recording for review: its
        // description must name its source.
        if (!resolved.channelUrl) {
            return {
                observedIdentifier,
                status: "review_required",
                streamerId: null,
                alias: null,
                streamerUrl: null,
                aliasUrl: null,
                reason: `no_source_links:${recording.provider}`,
                updatedAt: timestamp,
            };
        }
        return {
            observedIdentifier,
            status: "resolved",
            streamerId: resolved.id,
            alias: resolved.label,
            streamerUrl: resolved.channelUrl,
            aliasUrl: resolved.aliasUrl ?? null,
            reason: null,
            updatedAt: timestamp,
        };
    }
}
