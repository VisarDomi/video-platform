import { promises as fs } from "node:fs";
import path from "node:path";
import {
    extractRecordingIdentifier,
    parseStreamerTargetLine,
    streamerSourceLinks,
    targetMembershipIdentifiers,
    type StreamProvider,
    type StreamerTarget,
} from "shared";
import type { RecordingInput, RecordingProvenance } from "../domain/types.js";

export interface TargetResolverConfig {
    readonly targetFiles: Readonly<Record<StreamProvider, string>>;
    readonly tangoAliasesPath: string;
}

type AliasHistory = Readonly<Record<string, readonly string[]>>;

function normalizeAliasHistory(value: unknown): AliasHistory {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, string[]> = {};
    for (const [id, raw] of Object.entries(value)) {
        const aliases = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
        result[id] = aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim() !== "");
    }
    return result;
}

async function readText(filePath: string): Promise<string> {
    try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
}

async function readAliasHistory(filePath: string): Promise<AliasHistory> {
    try { return normalizeAliasHistory(JSON.parse(await fs.readFile(filePath, "utf8"))); } catch { return {}; }
}

function isProvider(value: string): value is StreamProvider {
    return value === "tango" || value === "fc2" || value === "sc";
}

export class TargetCatalogResolver {
    private constructor(
        private readonly targets: Readonly<Record<StreamProvider, readonly StreamerTarget[]>>,
        private readonly tangoAliases: AliasHistory,
    ) {}

    static async load(config: TargetResolverConfig): Promise<TargetCatalogResolver> {
        const [tango, fc2, sc, aliases] = await Promise.all([
            readText(config.targetFiles.tango),
            readText(config.targetFiles.fc2),
            readText(config.targetFiles.sc),
            readAliasHistory(config.tangoAliasesPath),
        ]);
        const parse = (provider: StreamProvider, content: string) => content.split(/\r?\n/)
            .map((line) => parseStreamerTargetLine(provider, line))
            .filter((target): target is StreamerTarget => target !== null);
        return new TargetCatalogResolver({
            tango: parse("tango", tango),
            fc2: parse("fc2", fc2),
            sc: parse("sc", sc),
        }, aliases);
    }

    resolve(recording: RecordingInput, now = new Date()): Omit<RecordingProvenance, "recordingId"> {
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
        const target = this.targets[recording.provider].find((candidate) => {
            if (recording.provider === "sc" && candidate.id === candidate.label) return false;
            const aliases = recording.provider === "tango" ? this.tangoAliases[candidate.id] ?? [] : [];
            return targetMembershipIdentifiers(candidate, aliases).includes(observedIdentifier);
        });
        if (!target) {
            return {
                observedIdentifier,
                status: "review_required",
                streamerId: null,
                alias: null,
                streamerUrl: null,
                aliasUrl: null,
                reason: "identifier_not_resolved_by_current_target_catalog",
                updatedAt: timestamp,
            };
        }
        const links = streamerSourceLinks(target);
        return {
            observedIdentifier,
            status: "resolved",
            streamerId: target.id,
            alias: target.label,
            streamerUrl: links.streamerUrl,
            aliasUrl: links.aliasUrl,
            reason: null,
            updatedAt: timestamp,
        };
    }
}
