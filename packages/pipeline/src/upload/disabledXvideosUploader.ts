export interface UploadRequest {
    readonly recordingId: string;
    readonly artifactPath: string;
    readonly sizeBytes: number;
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly visibility: "private";
    readonly streamerAlias?: string;
    readonly onProgress?: (
        phase: "file_uploading" | "file_uploaded" | "metadata_submitting",
        transmittedBytes: number,
    ) => Promise<void> | void;
}

export interface UploadReceipt {
    readonly transmittedBytes: number;
    readonly submittedVideoId: string | null;
    readonly metadataSubmittedAt: string;
}

// One browser session per upload: the existence check runs inside the same
// session, and the outcome tells the caller what happened.
export type UploadOutcome =
    | { kind: "uploaded"; receipt: UploadReceipt }
    | { kind: "existing"; remoteId: string; remoteUrl: string }
    | { kind: "title_mismatch"; remoteId: string };

export interface XvideosUploader {
    upload(request: UploadRequest): Promise<UploadOutcome>;
}

export class DisabledXvideosUploader implements XvideosUploader {
    async upload(_request: UploadRequest): Promise<never> {
        throw new Error(
            "XVideos network uploads are disabled; set the explicit pipeline network-upload opt-in after satisfying production blockers",
        );
    }
}
