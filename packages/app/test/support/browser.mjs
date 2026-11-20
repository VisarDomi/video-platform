import { chromium, webkit } from 'playwright-core';

// The browser the page tests drive: the system's Chromium, which the OS keeps updated.
// Browsers that Playwright downloads are never used: nothing updates them. A WebKit build
// is opt-in, through WEBKIT_EXECUTABLE_PATH, to check Safari-only behaviour by hand.
export function launchPageBrowser(options = {}) {
    const webkitPath = process.env.WEBKIT_EXECUTABLE_PATH;
    if (webkitPath) return webkit.launch({ ...options, executablePath: webkitPath });
    return chromium.launch({ ...options, executablePath: process.env.VIDEO_CHROMIUM_PATH ?? '/usr/bin/chromium' });
}
