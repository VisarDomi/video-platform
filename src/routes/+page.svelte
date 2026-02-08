<script lang="ts">
	import { goto } from '$app/navigation';
	import { DEFAULT_PROVIDER } from '$lib/constants.js';

	goto(`/videos/${DEFAULT_PROVIDER}`, { replaceState: true });
</script>
