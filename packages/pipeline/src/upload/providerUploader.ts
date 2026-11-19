import type { ActiveUploadProvider } from "../config/uploadProviders.js";

// The request and outcome shapes are the SDK's, shared with destination plug-ins.
import type { UploadOutcome, UploadRequest } from "sdk";
export type { UploadOutcome, UploadReceipt, UploadRequest } from "sdk";

export interface ProviderUploader {
    readonly provider?: ActiveUploadProvider;
    // When the remote copy comes into existence (a Destination's creationBoundary);
    // "metadata_submit" when not given.
    readonly creationBoundary?: "metadata_submit" | "transfer_start";
    upload(request: UploadRequest): Promise<UploadOutcome>;
}

export class DisabledUploader implements ProviderUploader {
    async upload(_request: UploadRequest): Promise<never> {
        throw new Error(
            "Network uploads are disabled; set the explicit pipeline network-upload opt-in after satisfying production blockers",
        );
    }
}
