// The deployment's capture sites, from the server (GET /api/sites): the sites file's, in
// its order. The first is the default page.
export interface Site {
	readonly id: string;
	readonly label: string;
	readonly list: boolean;
}

let loaded: Promise<readonly Site[]> | undefined;

export function loadSites(): Promise<readonly Site[]> {
	loaded ??= fetch('/api/sites').then(async (response) => {
		if (!response.ok) throw new Error(`The site list could not be loaded: ${response.status}`);
		const { sites } = (await response.json()) as { sites?: Site[] };
		if (!Array.isArray(sites) || sites.length === 0) throw new Error('The server lists no sites');
		return sites;
	}).catch((error: unknown) => {
		loaded = undefined;
		throw error;
	});
	return loaded;
}
