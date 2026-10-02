import { STORAGE_KEYS, VIDEO_TYPE, type Provider } from '../constants.js';
import { fetchVideos } from '../services/api.js';
import { getProvider, videoUrl } from '../providers/index.js';
import { VideoCatalog } from '../services/catalog.js';
import type { Video } from '../types.js';
import { formatDuration, formatSize } from '../utils/format.js';

const POLL_MS = 1000;

interface Row {
	element: HTMLAnchorElement;
	name: HTMLSpanElement;
	duration: HTMLSpanElement;
	size: HTMLSpanElement;
}

class VideoListPage {
	private readonly source;
	private readonly catalog;
	private readonly list = document.createElement('main');
	private readonly rows = new Map<string, Row>();
	private videos: Video[] = [];
	private pollTimer: number | null = null;
	private polling = false;
	private pollController: AbortController | null = null;
	private refreshToken = 0;
	private refreshController: AbortController | null = null;
	private lifecycleToken = 0;
	private highlightedFilename: string | null = null;

	constructor(private readonly provider: Provider) {
		this.source = getProvider(provider);
		this.catalog = new VideoCatalog(provider, videos => { this.videos = videos; this.reconcile(videos); });
		this.list.className = 'video-list';
		this.list.setAttribute('aria-label', `${provider} videos`);
	}

	async open(): Promise<void> {
		document.title = `${this.provider} - Video Editor`;
		document.body.replaceChildren(status('Loading…'));
		this.readHighlight();
		if (this.source.kind === 'local') await this.refresh();
		else await this.catalog.open(performance.getEntriesByType('navigation').some(entry => (entry as PerformanceNavigationTiming).type === 'back_forward'));
		document.body.replaceChildren(this.list);
		if (this.source.kind === 'online' && typeof history.state?.videoListY === 'number') window.scrollTo(0, history.state.videoListY);
		else this.scrollToHighlight();
		this.list.addEventListener('click', () => {
			if (this.source.kind === 'online') history.replaceState({ ...history.state, videoListY: window.scrollY }, '');
		});
		this.startPolling();
		addEventListener('pagehide', this.handlePageHide);
		addEventListener('pageshow', this.handlePageShow);
		document.addEventListener('visibilitychange', this.handleVisibility);
		addEventListener('online', this.handleOnline);
	}

	private readHighlight(): void {
		this.highlightedFilename = localStorage.getItem(
			STORAGE_KEYS.HIGHLIGHT_PREFIX + this.provider
		);
	}

	private readonly handlePageHide = (): void => {
		this.lifecycleToken++;
		this.stopPolling();
	};

	private readonly handleVisibility = (): void => {
		if (document.visibilityState === 'hidden') this.handlePageHide();
		else void this.restore();
	};

	private readonly handleOnline = (): void => {
		if (document.visibilityState === 'visible') void this.restore();
	};

	private readonly handlePageShow = (event: PageTransitionEvent): void => {
		if (!event.persisted) return;
		this.stopPolling();
		void this.restore();
	};

	private async restore(): Promise<void> {
		const lifecycle = ++this.lifecycleToken;
		this.stopPolling();
		this.readHighlight();
		try {
			if (this.source.kind === 'local') await this.refresh();
			else this.catalog.resume();
		} catch (error) {
			if (lifecycle === this.lifecycleToken) console.error('Unable to refresh restored video list', error);
		} finally {
			if (lifecycle === this.lifecycleToken) this.startPolling();
		}
	}

	private async refresh(): Promise<void> {
		const token = ++this.refreshToken;
		this.refreshController?.abort();
		const controller = new AbortController();
		this.refreshController = controller;
		const videos = await fetchVideos(this.provider, undefined, controller.signal);
		if (token !== this.refreshToken) return;
		this.videos = videos;
		this.reconcile(videos);
	}

	private scrollToHighlight(): void {
		if (!this.highlightedFilename) return;
		const highlighted = this.list.querySelector<HTMLElement>('.video-row.current-video');
		highlighted?.scrollIntoView({ block: 'center' });
	}

	private reconcile(videos: Video[]): void {
		const present = new Set(videos.map(videoKey));
		for (const [key, row] of this.rows) {
			if (present.has(key)) continue;
			row.element.remove();
			this.rows.delete(key);
		}

		if (videos.length === 0) {
			this.list.replaceChildren(status('No videos found.'));
			this.rows.clear();
			return;
		}

		for (const video of videos) {
			const key = videoKey(video);
			let row = this.rows.get(key);
			if (!row) {
				row = createRow();
				this.rows.set(key, row);
			}
			this.updateRow(row, video);
			this.list.append(row.element);
		}
	}

	private updateRow(row: Row, video: Video): void {
		const estimatedSize = video.duration * this.source.estimatedBytesPerSecond;
		row.element.href = videoUrl(video);
		row.element.classList.toggle('current-video', video.filename === this.highlightedFilename);
		row.element.classList.toggle('live', video.isLive === true);
		row.element.classList.toggle('edited', video.type === VIDEO_TYPE.EDITED);
		row.name.textContent = video.title ?? video.filename;
		const liveStream = this.source.kind === 'online' && this.source.live !== undefined;
		row.duration.textContent = liveStream ? 'LIVE' : formatDuration(video.duration);
		row.size.textContent = liveStream ? '' : formatSize(estimatedSize);
		row.size.classList.toggle('large', estimatedSize > 350 * 1024 * 1024);
	}

	private startPolling(): void {
		if (this.source.kind === 'online') { this.catalog.resume(); return; }
		if (this.pollTimer !== null || document.visibilityState === 'hidden') return;
		this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS);
	}

	private stopPolling(): void {
		this.catalog.stop();
		this.refreshToken++;
		this.refreshController?.abort();
		this.refreshController = null;
		if (this.pollTimer !== null) clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.pollController?.abort();
		this.pollController = null;
		this.polling = false;
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		const latest = this.videos[this.videos.length - 1]?.filename;
		this.polling = true;
		const controller = new AbortController();
		this.pollController = controller;
		try {
			const additions = await fetchVideos(this.provider, latest, controller.signal);
			if (additions.length === 0) return;
			const existing = new Set(this.videos.map(videoKey));
			for (const video of additions) {
				if (existing.has(videoKey(video))) continue;
				this.videos.push(video);
				existing.add(videoKey(video));
			}
			this.videos.sort((a, b) => a.filename.localeCompare(b.filename));
			this.reconcile(this.videos);
		} catch (error) {
			if (controller.signal.aborted) return;
			console.error('Video list polling failed', error);
		} finally {
			if (this.pollController === controller) {
				this.pollController = null;
				this.polling = false;
			}
		}
	}
}

function createRow(): Row {
	const element = document.createElement('a');
	element.className = 'video-row';
	const name = document.createElement('span');
	name.className = 'video-name';
	const meta = document.createElement('span');
	meta.className = 'video-meta';
	const duration = document.createElement('span');
	const size = document.createElement('span');
	size.className = 'video-size';
	meta.append(duration, size);
	element.append(name, meta);
	return { element, name, duration, size };
}

function videoKey(video: Video): string {
	return `${video.filename}\u001f${video.type}`;
}

function status(text: string): HTMLParagraphElement {
	const message = document.createElement('p');
	message.className = 'status';
	message.textContent = text;
	return message;
}

export async function openVideoList(provider: Provider): Promise<void> {
	await new VideoListPage(provider).open();
}
