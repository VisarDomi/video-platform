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
            const original = 'document.open();\n    document.close();';
            if (!source.includes(original)) throw new Error('Stream takeover changed; inspect the Safari adapter');
            return source.replace(original, 'document.documentElement?.replaceChildren();');
        },
    }] : [
        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${pkg.name} v${pkg.version}`,
                namespace: "https://github.com/VisarDomi",
                description: "stream viewer takeover",
                match: ["https://tango.me/*", "https://www.tango.me/*"],
                "run-at": "document-start",
            },
        }),
    ],
}));
