export function logEvent(event: string, data?: Record<string, unknown>): void {
	fetch('/api/log', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ event, data })
	}).catch(() => {});
}
