// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
    // This is the root of our frontend code
    root: "public",
    build: {
        // This is the directory where the production build will be placed
        outDir: "../dist/client",
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
