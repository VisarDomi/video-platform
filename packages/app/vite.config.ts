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
	clearScreen: false,
	build: {
		outDir: 'build'
	},
	server: {
		host: '0.0.0.0',
		port: 43210,
		https: getHttpsConfig(),
		proxy: {
			'/api': 'http://localhost:7973',
			'/hls': 'http://localhost:7973'
		}
	}
});
