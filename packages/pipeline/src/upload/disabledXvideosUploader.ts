export interface UploadRequest {
    readonly recordingId: string;
    readonly artifactPath: string;
    readonly sizeBytes: number;
    readonly title: string;
    readonly description: string;
    readonly visibility: "private";
}

export interface UploadReceipt {
    readonly remoteId: string;
    readonly remoteUrl: string;
    readonly transmittedBytes: number;
}

export interface XvideosUploader {
    upload(request: UploadRequest): Promise<UploadReceipt>;
}

export class DisabledXvideosUploader implements XvideosUploader {
    async upload(_request: UploadRequest): Promise<never> {
        throw new Error(
            "XVideos network uploads are disabled until its authenticated request and verification flow are manually established",
        );
    }
}
