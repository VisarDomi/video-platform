export interface UploadRequest {
    readonly recordingId: string;
    readonly artifactPath: string;
    readonly sizeBytes: number;
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly matchKey: string;
    readonly visibility: "private";
    readonly model?: {
        readonly stageName: string;
        readonly gender: string;
        readonly howKnown: string;
        readonly profilePicture: string;
        readonly xvideosModelId: string | null;
        readonly selectionMode: "manual" | "automatic-known";
    };
    readonly onProgress?: (
        phase: "file_uploading" | "file_uploaded" | "metadata_submitting",
        transmittedBytes: number,
    ) => Promise<void> | void;
}

export interface UploadReceipt {
    readonly transmittedBytes: number;
    readonly remoteEntry: {
        readonly remoteId: string;
        readonly remoteUrl: string;
        readonly moderationStatus: string | null;
    } | null;
    readonly metadataSubmittedAt: string;
    readonly selectedModelId: string | null;
}

export interface XvideosUploader {
    upload(request: UploadRequest): Promise<UploadReceipt>;
}

export class DisabledXvideosUploader implements XvideosUploader {
    async upload(_request: UploadRequest): Promise<never> {
        throw new Error(
            "XVideos network uploads are disabled; set the explicit pipeline network-upload opt-in after satisfying production blockers",
        );
    }
}
