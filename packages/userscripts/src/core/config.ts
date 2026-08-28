// The video platform server the download-list controls talk to.
// Override at build time with VITE_VIDEO_SERVER_URL when the LAN address changes.
export const SERVER: string =
    (import.meta.env.VITE_VIDEO_SERVER_URL as string | undefined)
    ?? "https://192.168.1.197:9999";
