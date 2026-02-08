import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const GET: RequestHandler = async () => {
	if (process.env.NODE_ENV === 'production') {
		error(404, 'Cert download only available in local dev');
	}

	try {
		const mkcertPath = path.join(os.homedir(), '.local/share/mkcert');
		const certPath = path.join(mkcertPath, 'rootCA.pem');

		const certFile = fs.readFileSync(certPath);

		return new Response(certFile, {
			headers: {
				'Content-Disposition': 'attachment; filename="rootCA.pem"',
				'Content-Type': 'application/x-x509-ca-cert'
			}
		});
	} catch (e) {
		console.error('Failed to read rootCA.pem', e);
		error(500, 'Certificate not found on server');
	}
};
