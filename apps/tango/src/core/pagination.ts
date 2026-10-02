import type { Provider, Stream } from "../provider";
import { AuthenticationRequiredError } from "../provider/types";

// Append in provider order. A stopped page must never overwrite the state saved
// by a newer document; its persisted cursor lets that document resume instead.
export function appendPages(
    provider: Provider, streams: Stream[], cursor: string | undefined,
    appended: (added: Stream[], nextPage?: string) => void,
    failed: (error: unknown) => void,
): () => void {
    let stopped = false;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    let finishWait: (() => void) | undefined;
    void (async () => {
        const seen = new Set(streams.map(stream => stream.streamerId));
        let retryDelay = 1_000;
        while (!stopped && cursor && provider.fetchStreamPage) {
            let page;
            try {
                page = await provider.fetchStreamPage(cursor, controller.signal);
            } catch (error) {
                if (stopped) return;
                failed(error);
                // An expired login needs the native login flow. All other page
                // failures keep the cursor and recover without a user action.
                if (error instanceof AuthenticationRequiredError) return;
                await new Promise<void>(resolve => {
                    finishWait = resolve;
                    retryTimer = window.setTimeout(resolve, retryDelay);
                });
                retryTimer = undefined;
                finishWait = undefined;
                retryDelay = Math.min(retryDelay * 2, 30_000);
                continue;
            }
            if (stopped) return;
            retryDelay = 1_000;
            const added = page.streams.filter(stream => {
                if (seen.has(stream.streamerId)) return false;
                seen.add(stream.streamerId);
                return true;
            });
            streams.push(...added);
            cursor = page.nextPage;
            appended(added, cursor);
        }
    })().catch(error => { if (!stopped) failed(error); });
    return () => {
        stopped = true;
        controller.abort();
        window.clearTimeout(retryTimer);
        finishWait?.();
    };
}
