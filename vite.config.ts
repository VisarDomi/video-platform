// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    // Why: The root of our frontend code is no longer `public`, but `src/frontend`.
    // Vite will now run its development server and build process from this directory.
    root: "src/frontend",
    build: {
        // Why: The output path needs to be adjusted relative to the new `root`.
        // `../../dist/frontend` means: from `src/frontend`, go up to `src`, then up to the
        // project root, and then into `dist/frontend`.
        outDir: "../../dist/frontend",
        emptyOutDir: true, // Clean the output directory before building
    },
    server: {
        // This proxies API requests to our backend server during development
        proxy: {
            "/api": "http://localhost:7998",
            "/video": "http://localhost:7998",
        },
    },
});
