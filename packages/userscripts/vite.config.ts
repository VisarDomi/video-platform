import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";

export default defineConfig({
    build: {
        minify: false,
        sourcemap: false,
        target: "esnext",
        modulePreload: false,
        cssCodeSplit: false,
        emptyOutDir: false,
    },
    plugins: [
        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "Video platform download-list controls (fc2 + stripchat)",
                match: ["https://live.fc2.com/*", "https://stripchat.com/*"],
                grant: ["GM_xmlhttpRequest"],
                connect: ["192.168.1.197"],
            },
            build: {
                fileName: "video-platform.user.js",
            },
        }),
    ],
});
