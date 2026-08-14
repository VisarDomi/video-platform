export type UploadProvider = "xvideos" | "bunkr";

export interface UploadPolicyEvidence {
    readonly url: string;
    readonly verifiedAt: string;
    readonly note: string;
}

export interface ProviderUploadPolicy {
    readonly provider: UploadProvider;
    readonly uploadVisibility: "private" | null;
    readonly minimumDurationSeconds: number | null;
    readonly maximumDurationSeconds: number | null;
    readonly maximumFileBytes: number | null;
    readonly inactiveDeletionDays: number | null;
    readonly maintenanceVisitIntervalDays: number | null;
    readonly unresolvedConstraints: readonly string[];
    readonly evidence: readonly UploadPolicyEvidence[];
}

export interface UploadProviderPlan {
    readonly primary: UploadProvider;
    readonly backups: readonly UploadProvider[];
    readonly unavailableBackups: readonly {
        readonly provider: UploadProvider;
        readonly reason: string;
    }[];
}

export interface SharedUploadPolicy {
    readonly providers: readonly UploadProvider[];
    readonly minimumDurationSeconds: number | null;
    readonly maximumDurationSeconds: number | null;
    readonly maximumFileBytes: number;
    readonly unresolvedConstraints: readonly string[];
}

const XVIDEOS_MAXIMUM_DURATION_SECONDS = 2 * 60 * 60;
const XVIDEOS_MAXIMUM_FILE_BYTES = 50_000_000_000;
const BUNKR_MAXIMUM_FILE_BYTES = 2_000_000_000;
const BUNKR_INACTIVE_DELETION_DAYS = 30;
const BUNKR_MAINTENANCE_VISIT_INTERVAL_DAYS = 15;

export const UPLOAD_PROVIDER_PLAN: UploadProviderPlan = {
    primary: "xvideos",
    backups: [],
    unavailableBackups: [{
        provider: "bunkr",
        reason: "Registrations are closed until further notice.",
    }],
};

export const PROVIDER_UPLOAD_POLICIES: Readonly<Record<UploadProvider, ProviderUploadPolicy>> = {
    xvideos: {
        provider: "xvideos",
        uploadVisibility: "private",
        minimumDurationSeconds: null,
        maximumDurationSeconds: XVIDEOS_MAXIMUM_DURATION_SECONDS,
        maximumFileBytes: XVIDEOS_MAXIMUM_FILE_BYTES,
        inactiveDeletionDays: null,
        maintenanceVisitIntervalDays: null,
        unresolvedConstraints: [
            "minimumDurationSeconds",
            "acceptedContainersAndCodecsBeyondH264AacMp4",
        ],
        evidence: [{
            url: "https://www.xvideos.com/account/uploads/new",
            verifiedAt: "2026-08-13",
            note: "Authenticated upload form confirms two hours, 50 GB, 255 title characters, 1000 description characters, and 20 tags. A validated H.264/AAC MP4 uploaded successfully without saving metadata; the minimum duration remains unknown.",
        }],
    },
    bunkr: {
        provider: "bunkr",
        uploadVisibility: null,
        minimumDurationSeconds: null,
        maximumDurationSeconds: null,
        maximumFileBytes: BUNKR_MAXIMUM_FILE_BYTES,
        inactiveDeletionDays: BUNKR_INACTIVE_DELETION_DAYS,
        maintenanceVisitIntervalDays: BUNKR_MAINTENANCE_VISIT_INTERVAL_DAYS,
        unresolvedConstraints: ["acceptedContainersAndCodecs", "uploadVisibility"],
        evidence: [
            {
                url: "https://bunkr.si/",
                verifiedAt: "2026-08-11",
                note: "Home page states a maximum upload size of two GB per file.",
            },
            {
                url: "https://bunkr.si/faq",
                verifiedAt: "2026-08-11",
                note: "FAQ says inactive files are deleted 30 days after their last visit; the configured 15-day visit interval leaves one missed-visit margin.",
            },
        ],
    },
};

export function deriveSharedUploadPolicy(
    policies: readonly ProviderUploadPolicy[],
): SharedUploadPolicy {
    if (policies.length === 0) throw new Error("At least one upload provider policy is required");

    const minimumDurations = policies
        .map((policy) => policy.minimumDurationSeconds)
        .filter((value): value is number => value !== null);
    const maximumFileSizes = policies
        .map((policy) => policy.maximumFileBytes)
        .filter((value): value is number => value !== null);
    const maximumDurations = policies
        .map((policy) => policy.maximumDurationSeconds)
        .filter((value): value is number => value !== null);

    if (maximumFileSizes.length === 0) {
        throw new Error("The shared upload policy needs a known maximum file size");
    }

    return {
        providers: policies.map((policy) => policy.provider),
        minimumDurationSeconds: minimumDurations.length > 0 ? Math.max(...minimumDurations) : null,
        maximumDurationSeconds: maximumDurations.length > 0 ? Math.min(...maximumDurations) : null,
        maximumFileBytes: Math.min(...maximumFileSizes),
        unresolvedConstraints: policies.flatMap((policy) =>
            policy.unresolvedConstraints.map((constraint) => `${policy.provider}.${constraint}`)
        ),
    };
}

export const SHARED_UPLOAD_POLICY = deriveSharedUploadPolicy([
    PROVIDER_UPLOAD_POLICIES[UPLOAD_PROVIDER_PLAN.primary],
    ...UPLOAD_PROVIDER_PLAN.backups.map((provider) => PROVIDER_UPLOAD_POLICIES[provider]),
]);
