export function formatDuration(seconds: number | null): string {
	if (seconds === null || Number.isNaN(seconds) || seconds <= 0) return '--:--';
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60)
		.toString()
		.padStart(2, '0');
	const remainingSeconds = String(total % 60).padStart(2, '0');
	return hours > 0 ? `${hours}:${minutes}:${remainingSeconds}` : `${minutes}:${remainingSeconds}`;
}

export function formatSize(bytes: number): string {
	if (Number.isNaN(bytes) || bytes <= 0) return '-- MiB';
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatTimePrecise(seconds: number): string {
	if (Number.isNaN(seconds)) return '00:00.000';
	const milliseconds = Math.floor((seconds % 1) * 1000)
		.toString()
		.padStart(3, '0');
	const total = Math.floor(seconds);
	const hours = String(Math.floor(total / 3600)).padStart(2, '0');
	const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
	const remainingSeconds = String(total % 60).padStart(2, '0');
	return total >= 3600
		? `${hours}:${minutes}:${remainingSeconds}.${milliseconds}`
		: `${minutes}:${remainingSeconds}.${milliseconds}`;
}
