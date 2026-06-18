import { defineConfig, type Plugin } from "vite";
import monkey from "vite-plugin-monkey";
import pkg from "./package.json";
import { CONSTANTS } from "./src/core/constants";

function finalBundlePlugin(): Plugin {
    return {
        name: "userscript-injector-plugin",

        renderChunk(code: string) {
            const injectorWrapper = `

    'use strict';
    async function main() {
${code}
    }
    const script = document.createElement("script");
    script.id = '${CONSTANTS.DOM.INJECTED_SCRIPT_ID}';
    script.textContent = '(' + main.toString() + ')();';
    document.documentElement.appendChild(script);
`;

            return {
                code: injectorWrapper,
                map: null,
            };
        },
    };
}

export default defineConfig({
    build: {
        minify: false,
        sourcemap: false,
    },
    plugins: [
        finalBundlePlugin(),

        monkey({
            entry: "src/main.ts",
            userscript: {
                name: `${pkg.name} v${pkg.version}`,
                match: CONSTANTS.USERSCRIPT.MATCH_URLS,
                "run-at": "document-start",
            },
        }),
    ],
});
