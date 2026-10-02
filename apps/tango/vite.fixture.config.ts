import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
    build: {
        emptyOutDir: false,
        minify: false,
        target: "esnext",
        lib: {
            entry: resolve(import.meta.dirname, "tests/ios/fixture.ts"),
            formats: ["iife"],
            name: "StreamViewerFixture",
            fileName: () => "stream-viewer-fixture.js",
        },
    },
});
