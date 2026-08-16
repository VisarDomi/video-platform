export { downloadsRoot, providerFolder, providerFolders, VIDEO_FOLDER_KINDS } from "./providerLayout.js";
export type { VideoFolderKind } from "./providerLayout.js";
export { fixTargetDuration, selectLongestMediaDuration } from "./hlsUtils.js";
export { readTokens } from "./tokenManager.js";
export type { Tokens } from "./tokenManager.js";

export { createLogger } from "./logger.js";
export { moveToDesktopTrash } from "./desktopTrash.js";
export {
    PROVIDER_UPLOAD_POLICIES,
    SHARED_UPLOAD_POLICY,
    UPLOAD_PROVIDER_PLAN,
    deriveSharedUploadPolicy,
} from "./uploadPolicy.js";
export type {
    ProviderUploadPolicy,
    SharedUploadPolicy,
    UploadPolicyEvidence,
    UploadProvider,
    UploadProviderPlan,
} from "./uploadPolicy.js";
export {
    assessFinalArtifact,
    assessRecording,
    planRecordingsForUpload,
} from "./uploadPlanner.js";
export {
    extractRecordingIdentifier,
    formatStreamerTarget,
    parseStreamerTargetLine,
    streamerSourceLinks,
    targetMembershipIdentifiers,
} from "./streamerTarget.js";
export type {
    StreamProvider,
    StreamerSourceLinks,
    StreamerTarget,
} from "./streamerTarget.js";
export type {
    FinalUploadArtifact,
    RecordingUploadPlan,
    UploadAssessment,
    UploadCandidate,
    UploadDisposition,
    UploadNotification,
} from "./uploadPlanner.js";
