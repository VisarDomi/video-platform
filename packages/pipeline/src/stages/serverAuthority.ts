import path from "node:path";
import type { Recording } from "../domain/types.js";
import { inspectRecording } from "../discovery/inspectRecording.js";

interface AuthorityResponse {
    success?: boolean;
    error?: string;
    report?: { status?: string; invalidSegments?: unknown[] };
}

export interface ConfirmedIntegrity {
    readonly sourceFingerprint: string;
    readonly durationSeconds: number;
}

export class ServerAuthorityClient {
    constructor(private readonly baseUrl = "http://127.0.0.1:7973") {}

    async repairPlaylist(recording: Recording): Promise<void> {
        await this.post(recording, "repair-playlist");
    }

    async confirmIntegrity(recording: Recording): Promise<ConfirmedIntegrity> {
        const response = await this.post(recording, "integrity");
        if (response.report?.status === "failed" && (response.report.invalidSegments?.length ?? 0) > 0) {
            await this.post(recording, "repair-failed-integrity");
        }
        const inspection = await inspectRecording(recording.sourcePath, recording.provider, recording.sourceKind);
        if (inspection.status !== "eligible") {
            throw new Error(`Recording is not integrity-ready: ${inspection.reason}`);
        }
        return {
            sourceFingerprint: inspection.recording.sourceFingerprint,
            durationSeconds: inspection.recording.durationSeconds,
        };
    }

    private async post(recording: Recording, action: string): Promise<AuthorityResponse> {
        const filename = path.basename(recording.sourcePath);
        const url = new URL([
            "api", "pipeline", "recordings",
            encodeURIComponent(recording.provider),
            encodeURIComponent(recording.sourceKind),
            encodeURIComponent(filename),
            action,
        ].join("/"), `${this.baseUrl}/`);
        const response = await fetch(url, { method: "POST" });
        const body = await response.json() as AuthorityResponse;
        if (!response.ok || body.success !== true) {
            throw new Error(`Server ${action} failed (${response.status}): ${body.error ?? "unknown error"}`);
        }
        return body;
    }
}
