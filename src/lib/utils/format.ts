export function formatDuration(seconds: number | null): string {
	if (seconds === null || isNaN(seconds) || seconds <= 0) return '--:--';
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60)
		.toString()
		.padStart(2, '0');
	const s = (total % 60).toString().padStart(2, '0');
	return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function formatSize(bytes: number): string {
	if (isNaN(bytes) || bytes <= 0) return '-- MiB';
	const mib = bytes / (1024 * 1024);
	return `${mib.toFixed(1)} MiB`;
}

export function formatTimePrecise(seconds: number): string {
	if (isNaN(seconds)) return '00:00.000';
	const ms = Math.floor((seconds % 1) * 1000)
		.toString()
		.padStart(3, '0');
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600)
		.toString()
		.padStart(2, '0');
	const m = Math.floor((total % 3600) / 60)
		.toString()
		.padStart(2, '0');
	const s = (total % 60).toString().padStart(2, '0');
	return total >= 3600 ? `${h}:${m}:${s}.${ms}` : `${m}:${s}.${ms}`;
}
