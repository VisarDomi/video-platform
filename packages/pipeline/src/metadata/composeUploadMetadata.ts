import path from "node:path";
import type {
    DescriptionRecord,
    Recording,
    RecordingProvenance,
    UploadMetadataRecord,
} from "../domain/types.js";

const TITLE_LIMIT = 255;
const DESCRIPTION_LIMIT = 1_000;

interface DescriptorOutput {
    readonly title: string;
    readonly description: string;
}

function descriptorOutput(value: unknown): DescriptorOutput {
    if (!value || typeof value !== "object") throw new Error("Descriptor output must be an object");
    const candidate = value as Partial<DescriptorOutput>;
    if (typeof candidate.title !== "string" || typeof candidate.description !== "string") {
        throw new Error("Descriptor output requires title and description");
    }
    return { title: candidate.title, description: candidate.description };
}

function recordingTime(sourcePath: string): string {
    const match = path.basename(sourcePath).match(/^(\d{4}-\d{2}-\d{2})\s+(\d{6})\b/);
    if (!match) return "unknown";
    return `${match[1]} ${match[2].slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}`;
}

function shorten(text: string, maximum: number): string {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (normalized.length <= maximum) return normalized;
    const prefix = normalized.slice(0, Math.max(0, maximum - 1));
    const boundary = prefix.lastIndexOf(" ");
    return `${prefix.slice(0, boundary > maximum * 0.65 ? boundary : prefix.length).trimEnd()}…`;
}

export function composeUploadMetadata(
    recording: Recording,
    description: DescriptionRecord,
    provenance: RecordingProvenance,
): Omit<UploadMetadataRecord, "recordingId" | "createdAt"> {
    if (provenance.status === "review_required" || !provenance.streamerUrl) {
        throw new Error("Cannot compose upload metadata with unresolved provenance");
    }
    const output = descriptorOutput(description.output);
    // The folder name is the identity; the title carries it only for human
    // readability on XVideos.
    const folderSuffix = `[${path.basename(recording.sourcePath)}]`;
    const titleRoom = TITLE_LIMIT - folderSuffix.length - 1;
    const title = `${shorten(output.title, titleRoom)} ${folderSuffix}`;

    const suffix = [
        `Recorded: ${recordingTime(recording.sourcePath)}`,
        `Source: ${provenance.streamerUrl}`,
        ...(provenance.aliasUrl ? [`Alias: ${provenance.aliasUrl}`] : []),
    ].join("\n");
    const descriptionRoom = DESCRIPTION_LIMIT - suffix.length - 2;
    if (descriptionRoom < 20) throw new Error("Streamer provenance leaves no room for a description");
    const composedDescription = `${shorten(output.description, descriptionRoom)}\n\n${suffix}`;

    // Descriptor tags are intentionally ignored. The only tags uploaded are
    // the fixed provider tag and "live": fc2 -> fc2 + live, sc -> stripchat + live.
    const providerTag = recording.provider === "sc" ? "stripchat" : recording.provider;
    return { title, description: composedDescription, tags: [providerTag, "live"] };
}
