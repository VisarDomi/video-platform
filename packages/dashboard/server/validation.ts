import { PROVIDER_IDS, type ProviderId } from './types.js';
import { Ok, Err, type Result } from './result.js';

export function parseProviderId(raw: string): Result<ProviderId> {
	if ((PROVIDER_IDS as readonly string[]).includes(raw)) {
		return Ok(raw as ProviderId);
	}
	return Err(`Invalid provider: "${raw}". Valid: ${PROVIDER_IDS.join(', ')}`);
}

export function parseMonth(raw: string): Result<string> {
	if (/^\d{4}-\d{2}$/.test(raw)) {
		return Ok(raw);
	}
	return Err('Invalid month format. Use YYYY-MM.');
}
