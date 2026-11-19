// The capture contract lives in the plug-in SDK; the downloader's core and its site
// implementations share these shapes.
export type {
    SegmentValidationResult,
    SegmentFetchResult,
    PlaylistFetchFailure,
    StreamVariantDescription,
    AccessFailureContext,
    IDownloadSession,
    IStreamProvider,
    DownloadExitContext,
} from "sdk";
