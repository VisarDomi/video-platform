import type { Video } from '../types.js';

export function extractAlias(filename: string): string {
	// tl filenames are just the alias (no timestamp prefix)
	// Regular filenames: 18-char timestamp + alias (e.g. "2024-01-01 123456 alias")
	if (filename.length > 18 && /^\d{4}-/.test(filename)) {
		return filename.substring(18);
	}
	return filename;
}

export function extractUniqueAliases(videos: Video[]): string[] {
	const aliases = new Set<string>();
	for (const video of videos) {
		const alias = extractAlias(video.filename);
		if (alias) aliases.add(alias);
	}
	return [...aliases].sort();
}
