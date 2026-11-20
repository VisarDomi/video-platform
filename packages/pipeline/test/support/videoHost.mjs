// The destination every pipeline test uploads to: "video-host", with a real host's limits
// (a two-minute minimum, 10 GB per file, public uploads; its copy exists once the metadata
// form is submitted). Tests hand the pipeline their own uploader and reconcile session, so
// a destination created from here refuses to be used.
import { SDK_VERSION } from "sdk";

const unused = () => { throw new Error("video-host is a test destination: pass the test's own uploader"); };

export const destination = {
    id: "video-host",
    sdkVersion: SDK_VERSION,
    creationBoundary: "metadata_submit",
    policy: { minimumDurationSeconds: 120, maximumDurationSeconds: null, maximumFileBytes: 10_000_000_000, uploadVisibility: "public" },
    createDestination: () => ({
        creationBoundary: "metadata_submit",
        upload: unused,
        findUploadedCopy: unused,
        withSession: unused,
        session: { check: unused, lostAdvice: "run `restore-session` to restore the shared session" },
    }),
};
export default destination;
