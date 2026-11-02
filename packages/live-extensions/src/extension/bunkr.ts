import { BunkrDownload, bunkrFileURL, bunkrHosts } from "../core/bunkrDownload";
import { openBunkrAlbum } from "../core/bunkrAlbum";

const scope = window as typeof window & { __bunkrToPcBoot?: boolean };
if (bunkrHosts.has(location.hostname) && !scope.__bunkrToPcBoot) {
    scope.__bunkrToPcBoot = true;
    if (/^\/a\/[a-zA-Z0-9]+\/?$/.test(location.pathname)) openBunkrAlbum();
    else installFileHandoff();
}

// Keep /f's site layout and native fallback; adapt only its download label/click.
function installFileHandoff(): void {
    const labels = new Map<HTMLAnchorElement, string>();
    let pageKey = "", control: BunkrDownload | undefined;
    function filePage(): string { return bunkrFileURL(location.href)?.pathname ?? ""; }
    function downloadLink(target: EventTarget | null): HTMLAnchorElement | undefined {
        if (!(target instanceof Element) || !filePage()) return undefined;
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return undefined;
        try { const url = new URL(anchor.href); if (url.protocol === "https:" && /^dl\.bunkr\.(si|ph|cr)$/.test(url.hostname) && /^\/file\/\d+$/.test(url.pathname)) return anchor; } catch { /* Not a file download. */ }
        return undefined;
    }
    function paint(): void {
        for (const [anchor, original] of labels) {
            if (!anchor.isConnected) { labels.delete(anchor); continue; }
            const text = control?.label ?? original;
            if (anchor.textContent !== text) anchor.textContent = text;
            anchor.title = "Download to ~/Videos/plab/bunkr on the PC";
        }
    }
    function discover(): void {
        const key = filePage();
        if (key !== pageKey) {
            control?.dispose();
            for (const [anchor, original] of labels) if (anchor.isConnected) anchor.textContent = original;
            labels.clear(); pageKey = key;
            const url = bunkrFileURL(location.href); control = url ? new BunkrDownload(url, paint) : undefined;
            control?.resume();
        }
        for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) if (downloadLink(anchor) && !labels.has(anchor)) labels.set(anchor, anchor.textContent ?? "Download");
        paint();
    }
    discover();
    new MutationObserver(discover).observe(document.documentElement, { childList: true, subtree: true });
    for (const event of ["online", "pageshow", "focus"]) window.addEventListener(event, () => { discover(); control?.resume(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) control?.resume(); else control?.suspend(); });
    setInterval(discover, 1000);
    document.addEventListener("click", event => {
        discover(); const anchor = downloadLink(event.target);
        if (!anchor || !control || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!control.hasJob && !control.submitting && !control.ready) { void control.refresh(true); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        void control.activate();
    }, true);
}
