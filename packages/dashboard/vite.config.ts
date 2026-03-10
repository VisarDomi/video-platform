import { sveltekit } from '@sveltejs/kit/vite';
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

export default defineConfig({
	plugins: [sveltekit()],
	clearScreen: false,
	server: {
		host: '0.0.0.0',
		port: 43213,
		https: getHttpsConfig(),
		proxy: {
			'/api': 'http://localhost:7976'
		}
	}
});
