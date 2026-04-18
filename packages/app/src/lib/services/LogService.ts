export type LogEvent =
    // Navigation
    | { event: 'nav-play'; filename: string; provider: string }
    | { event: 'nav-swipe'; dir: 1 | -1; from: string; to: string }
    | { event: 'nav-show-list'; from: string | null }
    | { event: 'nav-edge-back'; from: string | null }
    // Peek gesture
    | { event: 'peek-start'; dir: 1 | -1; peekFilename: string | null }
    | { event: 'peek-commit'; dir: 1 | -1; peekFilename: string | null }
    | { event: 'peek-cancel' }
    // Player unit lifecycle
    | { event: 'unit-load'; slot: number; filename: string; provider: string }
    | { event: 'unit-activate'; slot: number; filename: string; videoChanged: boolean }
    | { event: 'unit-clear'; slot: number; filename: string | null }
    // Playback
    | { event: 'playlist-fetch'; filename: string; fetchMs: number; segments: number; isLive: boolean; isFmp4: boolean; bytes: number; totalDuration: number; firstSegment: string | null; lastSegment: string | null }
    | { event: 'live-status-changed'; filename: string; isLive: boolean }
    | { event: 'video-removed'; filename: string }
    | { event: 'playback-tech-selected'; slot: number; filename: string; tech: 'hls.js' | 'native'; startTime: number; storeIsLive: boolean }
    | { event: 'manifest-state'; slot: number; filename: string; tech: 'hls.js' | 'native'; phase: string; manifestIsLive: boolean; manifestDuration: number; fragmentCount: number; startSN: number | null; endSN: number | null }
    | { event: 'media-state'; slot: number; filename: string; phase: string; currentTime: number; duration: number | null; seekableEnd: number | null; readyState: number; paused: boolean; ended: boolean; currentIsLive: boolean; storeIsLive: boolean }
    | { event: 'media-duration-mismatch'; slot: number; filename: string; phase: string; playlistDuration: number; mediaDuration: number | null; seekableEnd: number | null; durationDelta: number | null; seekableDelta: number | null }
    // Edit actions
    | { event: 'edit-begin'; filename: string; isFmp4: boolean; playlistSegments: number; timeMarkers: number }
    | { event: 'edit-playlist-fetch-failed'; filename: string }
    | { event: 'edit-segments-calculated'; filename: string; totalPlaylistSegments: number; timeRanges: number; totalDuration: number; segmentsToKeep: number; firstKept: string | null; lastKept: string | null }
    // UI state
    | { event: 'ui-visibility'; visible: boolean; source: string }
    | { event: 'overlay-state'; action: 'hide' | 'show'; activeFilename: string | null }
    | { event: 'svelte-overlay-render'; filename: string | null; isUiVisible: boolean; view: string }
    // Resume / recovery
    | { event: 'watchdog-freeze-resume' }
    | { event: 'sentinel-resume'; frozenSec: number }
    | { event: 'background-resume'; elapsedSec: number }
    | { event: 'online-resume' }
    // Global errors
    | { event: 'uncaught-error'; message: string; source: string; line: number; col: number; stack: string }
    | { event: 'unhandled-rejection'; message: string; stack: string };

type EventName = LogEvent['event'];
type PayloadOf<E extends EventName> = Omit<Extract<LogEvent, { event: E }>, 'event'>;
type HasPayload<E extends EventName> = keyof PayloadOf<E> extends never ? false : true;

export type LogEmit = <E extends EventName>(
    ...args: HasPayload<E> extends true ? [event: E, data: PayloadOf<E>] : [event: E]
) => void;

export class LogService {
    private cleanups: (() => void)[] = [];

    start(): void {
        if (typeof window === 'undefined') return;

        const onError = (event: ErrorEvent) => {
            this.emit('uncaught-error', {
                message: event.message,
                source: event.filename ?? '',
                line: event.lineno ?? 0,
                col: event.colno ?? 0,
                stack: event.error?.stack ?? '',
            });
        };

        const onRejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            this.emit('unhandled-rejection', {
                message: String(reason?.message ?? reason),
                stack: reason?.stack ?? '',
            });
        };

        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        this.cleanups.push(
            () => window.removeEventListener('error', onError),
            () => window.removeEventListener('unhandledrejection', onRejection),
        );
    }

    emit: LogEmit = ((event: string, data?: Record<string, unknown>) => {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event, data }),
        }).catch(() => {});
    }) as LogEmit;

    destroy(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
    }
}

export const logService = new LogService();
