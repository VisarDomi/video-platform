import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getHttpsConfig() {
	try {
		const mkcertPath = path.join(os.homedir(), '.local/share/mkcert');
		const pwaCertPath = path.join(mkcertPath, 'pwa');
		const keyPath = path.join(pwaCertPath, 'key.pem');
		const certPath = path.join(pwaCertPath, 'cert.pem');

		if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
			return {
				key: fs.readFileSync(keyPath),
				cert: fs.readFileSync(certPath)
			};
		}
	} catch (ignore) {}
	return undefined;
}

export default defineConfig(({ mode }) => ({
	clearScreen: false,
	resolve: { alias: { '@providers': path.resolve(import.meta.dirname, mode === 'xvideos' ? 'src/providers/xvideos-registry.ts' : 'src/providers/local-registry.ts') } },
	build: {
		outDir: 'build',
		...(mode === 'xvideos' ? {
			outDir: '../../dist/extension/xvideos',
			emptyOutDir: true,
			target: 'safari17',
			lib: { entry: path.resolve(import.meta.dirname, 'src/extension/main.ts'), name: 'VideoPlatform', formats: ['iife' as const], fileName: () => 'content.js' },
			rollupOptions: { output: { inlineDynamicImports: true } }
		} : {})
	},
	server: {
		host: '0.0.0.0',
		port: 43210,
		https: getHttpsConfig(),
		proxy: {
			'/api': 'http://localhost:9999',
			'/hls': 'http://localhost:9999'
		}
	}
}));
