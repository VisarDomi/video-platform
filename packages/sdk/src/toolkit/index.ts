// The toolkit: small, site-agnostic helpers that the core and the site plug-ins share.
// A plug-in imports only this package, so whatever a site needs from the protocol side
// lives here rather than in the core. Keep it lean: pure functions and one error type,
// no state, no I/O beyond the call itself.
//
//   requestSignal, resolveSegmentUrl, CDN_FETCH_TIMEOUT_MS
//       request timeouts and playlist URL resolution
//   PlaylistNotFoundError
//       a session's "the live playlist is gone" signal; the core ends the recording
//   normalizeRecordingId, formatTimestampForPath
//       the stored form of recording identities and time stamps in names
//   probeSegmentDimensions
//       MPEG-TS geometry via ffprobe, for validateSegment
//   inspectFragment, dropZeroSizeSamples
//       fMP4 fragment index checks and the zero-size sample repair

export { CDN_FETCH_TIMEOUT_MS, requestSignal, resolveSegmentUrl } from "./http.js";
export { PlaylistNotFoundError } from "./playlistNotFoundError.js";
export { formatTimestampForPath, normalizeRecordingId } from "./recordingId.js";
export { probeSegmentDimensions } from "./segmentDimensions.js";
export { dropZeroSizeSamples, inspectFragment } from "./fmp4Fragment.js";
export type { FragmentInspection, FragmentRepair } from "./fmp4Fragment.js";
