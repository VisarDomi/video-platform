<script lang="ts">
	import { goto } from '$app/navigation';
	import { DEFAULT_PROVIDER, STORAGE_KEYS } from '$lib/constants.js';

	const saved = localStorage.getItem(STORAGE_KEYS.SELECTED_PROVIDER);
	const provider = saved || DEFAULT_PROVIDER;
	goto(`/videos/${provider}`, { replaceState: true });
</script>
