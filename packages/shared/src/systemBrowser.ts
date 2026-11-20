// The browser every service launches: the system's Chromium, which the OS keeps updated
// (a daily Chromium-only upgrade plus the distribution's automatic updates). Browsers
// that Playwright downloads are never used, because nothing updates them.
// $VIDEO_CHROMIUM_PATH overrides it.
export function systemBrowserPath(): string {
    return process.env.VIDEO_CHROMIUM_PATH ?? "/usr/bin/chromium";
}
