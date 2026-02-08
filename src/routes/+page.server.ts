import { redirect } from '@sveltejs/kit';
import { DEFAULT_PROVIDER } from '$lib/constants.js';

export function load() {
	redirect(302, `/videos/${DEFAULT_PROVIDER}`);
}
