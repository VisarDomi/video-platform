import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";

export default defineConfig(({ mode }) => ({
    build: {
        emptyOutDir: mode === 'extension',
        ...(mode === 'extension' ? {
            outDir: 'dist/extension',
            lib: { entry: 'extension/main.ts', name: 'StreamViewer', formats: ['iife' as const], fileName: () => 'content.js' },
        } : {}),
        minify: false,
        sourcemap: false,
        target: "esnext",
        modulePreload: false,
        cssCodeSplit: false,
    },
    plugins: mode === 'extension' ? [{
        name: 'safari-document-takeover',
        enforce: 'pre',
        transform(source, id) {
            if (!id.endsWith('/src/core/page.ts')) return;
            const original = 'mode: "rewrite" | "replace" = "rewrite"';
            if (!source.includes(original)) throw new Error('Stream takeover changed; inspect the Safari adapter');
            return source.replace(original, 'mode: "rewrite" | "replace" = "replace"');
        },
    }] : [
        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "stream viewer takeover",
                match: ["https://tango.me/*", "https://www.tango.me/*", "https://xvideos.com/*", "https://www.xvideos.com/*"],
                "run-at": "document-start",
            },
        }),
    ],
}));
