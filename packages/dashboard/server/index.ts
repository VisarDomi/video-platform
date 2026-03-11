import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRegistry } from './registry.js';
import { registerRoutes } from './routes.js';

const app = express();
app.use(cors());
app.use(express.json());

const SNAPSHOTS_BASE = path.join(import.meta.dirname, '..', 'snapshots');
const registry = createRegistry(SNAPSHOTS_BASE);

registerRoutes(app, registry);

const FRONTEND_DIST = path.join(import.meta.dirname, '..', 'build');
app.use(express.static(FRONTEND_DIST));
app.get(/.*/, (_req, res) => {
	res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

const PORT = 7976;
const HOST = '0.0.0.0';

const mkcertPath = path.join(os.homedir(), '.local/share/mkcert/pwa');
const keyPath = path.join(mkcertPath, 'key.pem');
const certPath = path.join(mkcertPath, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
	const sslOptions = {
		key: fs.readFileSync(keyPath),
		cert: fs.readFileSync(certPath)
	};
	https.createServer(sslOptions, app).listen(PORT, HOST, () => {
		const interfaces = os.networkInterfaces();
		for (const [, addrs] of Object.entries(interfaces)) {
			for (const addr of addrs || []) {
				if (addr.family === 'IPv4' && !addr.internal) {
					console.log(`Dashboard running at https://${addr.address}:${PORT}`);
				}
			}
		}
	});
} else {
	console.warn('SSL certs not found, falling back to HTTP');
	app.listen(PORT, HOST, () => {
		console.log(`Dashboard running at http://localhost:${PORT}`);
	});
}
