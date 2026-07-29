import './style.css';
import { DEFAULT_PROVIDER, PROVIDERS, type Provider } from './constants.js';
import { openVideoList } from './routes/videoList.js';
import type { VideoType } from './types.js';
import { VIDEO_TYPE } from './constants.js';

function isProvider(value: string): value is Provider {
	return PROVIDERS.includes(value as Provider);
}

async function main(): Promise<void> {
	const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	if (parts.length === 0) {
		location.replace(`/videos/${DEFAULT_PROVIDER}`);
		return;
	}
	if (parts.length === 1 && isProvider(parts[0])) {
		const { TextEditorPage } = await import('./routes/textEditor.js');
		await new TextEditorPage(parts[0]).open();
		return;
	}
	if (parts[0] === 'videos' && parts.length === 2 && isProvider(parts[1])) {
		await openVideoList(parts[1]);
		return;
	}
	if (parts[0] === 'videos' && parts.length === 3 && isProvider(parts[1])) {
		const typeValue = new URLSearchParams(location.search).get('type');
		const type: VideoType | null =
			typeValue === VIDEO_TYPE.ORIGINAL || typeValue === VIDEO_TYPE.EDITED ? typeValue : null;
		const { VideoViewerPage } = await import('./routes/videoViewer.js');
		await new VideoViewerPage(parts[1], parts[2], type).open();
		return;
	}
	showError('Page not found.');
}

function showError(text: string): void {
	document.body.replaceChildren();
	const message = document.createElement('p');
	message.className = 'status status-error';
	message.textContent = text;
	document.body.append(message);
}

void main().catch((error: unknown) => {
	console.error(error);
	showError(error instanceof Error ? error.message : 'Unable to open the video application.');
});
