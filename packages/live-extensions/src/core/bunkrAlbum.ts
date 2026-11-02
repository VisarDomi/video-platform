import { BunkrDownload, bunkrFileURL } from "./bunkrDownload";
import css from "./bunkrAlbum.css";

type AlbumItem = { url: string; title: string; size: string; date: string; thumbnail?: string };
type Album = { title: string; summary: string; items: AlbumItem[] };
type Poster = { url: string; width?: number; height?: number };
type Row = { element: HTMLElement; image: HTMLImageElement; control: BunkrDownload; item: AlbumItem; visible: boolean; posterReady: boolean; posterBusy: boolean };

function sizeImage(image: HTMLImageElement, width: number, height: number): void {
    if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 100_000)) return;
    image.width = width; image.height = height;
    // Reserve cached intrinsic geometry before decoding, including fit-content
    // grid sizing. All three limits preserve the ratio and prevent enlargement.
    image.style.width = `min(66.6667vw, ${width}px, ${48 * width / height}svh)`;
    image.style.aspectRatio = `${width} / ${height}`;
}

function imageURL(value: string | null | undefined, base: string): string | undefined {
    if (!value || value.startsWith("#")) return undefined;
    try { const url = new URL(value, base); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; }
}
export function parseBunkrAlbum(html: string, base: string): Album {
    const doc = new DOMParser().parseFromString(html, "text/html"), items: AlbumItem[] = [], seen = new Set<string>();
    for (const card of doc.querySelectorAll("#galleryGrid .theItem, .grid-images .theItem")) {
        const anchor = card.querySelector<HTMLAnchorElement>('a[href*="/f/"]');
        const url = anchor && bunkrFileURL(anchor.getAttribute("href") ?? "", base);
        if (!url || seen.has(url.pathname)) continue;
        const title = card.querySelector(".theName")?.textContent?.trim() || card.getAttribute("title")?.trim();
        if (!title) continue;
        seen.add(url.pathname);
        items.push({ url: url.href, title, size: card.querySelector(".theSize")?.textContent?.trim() ?? "",
                     date: card.querySelector(".theDate")?.textContent?.trim() ?? "",
                     thumbnail: imageURL(card.querySelector(".grid-images_box-img")?.getAttribute("src"), base) });
    }
    if (!doc.querySelector("h1") || (!items.length && !doc.querySelector("#galleryGrid"))) throw new Error("The album could not be read.");
    return { title: doc.querySelector("h1")!.textContent?.trim() || "Bunkr", summary: doc.querySelector(".visitors .font-semibold")?.textContent?.trim() ?? "", items };
}
export function parseBunkrPoster(html: string, base: string): string | undefined {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // The player builds its video lazily. Read its JSON string literal rather
    // than executing page scripts or guessing a larger thumbnail's filename.
    const literal = html.match(/\bvideoCoverUrl\s*=\s*("(?:\\.|[^"\\])*")/);
    let cover: string | undefined;
    try { if (literal) cover = imageURL(JSON.parse(literal[1]), base); } catch { /* Use declared HTML metadata below. */ }
    return cover ?? imageURL(doc.querySelector("video[data-poster]")?.getAttribute("data-poster"), base)
        ?? imageURL(doc.querySelector("video[poster]")?.getAttribute("poster"), base)
        ?? imageURL(doc.querySelector('meta[property="og:image"]')?.getAttribute("content"), base);
}

export function openBunkrAlbum(): void {
    const pageURL = location.href, albumKey = `bunkr-album:v1:${location.pathname}`, posterKey = "bunkr-posters:v2";
    let posters: Record<string, Poster> = {};
    try { const saved = JSON.parse(sessionStorage.getItem(posterKey) ?? "{}"); if (saved && typeof saved === "object") posters = saved; } catch { /* Optional cache. */ }
    // The established manga/stream-viewer takeover, before asynchronous work.
    window.stop(); document.open(); document.write("<!doctype html><html><head></head><body></body></html>"); document.close();
    if (!document.documentElement) document.appendChild(document.createElement("html"));
    if (!document.doctype) document.insertBefore(document.implementation.createDocumentType("html", "", ""), document.documentElement);
    if (!document.head) document.documentElement.appendChild(document.createElement("head"));
    if (!document.body) document.documentElement.appendChild(document.createElement("body"));
    const viewport = document.createElement("meta"); viewport.name = "viewport"; viewport.content = "width=device-width,initial-scale=1,viewport-fit=cover";
    const style = document.createElement("style"); style.textContent = css; document.head.append(viewport, style);
    const header = document.createElement("header"), title = document.createElement("h1"), summary = document.createElement("p"); header.append(title, summary);
    const list = document.createElement("main"); list.id = "bunkr-album";
    const status = document.createElement("p"); status.className = "album-status"; status.textContent = "Loading…";
    document.body.append(header, list, status);
    const rows = new Map<string, Row>(), posterQueue: Row[] = [];
    let posterRequests = 0, hidden = document.hidden;

    function savePosters(): void { try { sessionStorage.setItem(posterKey, JSON.stringify(posters)); } catch { /* Optional cache. */ } }
    function setPoster(row: Row, poster: Poster): void {
        if (poster.width && poster.height) sizeImage(row.image, poster.width, poster.height);
        row.image.onload = () => {
            sizeImage(row.image, row.image.naturalWidth, row.image.naturalHeight);
            if (row.image.naturalWidth > 0 && row.image.currentSrc === poster.url) {
                posters[row.item.url] = { url: poster.url, width: row.image.naturalWidth, height: row.image.naturalHeight }; savePosters();
            }
        };
        row.image.src = poster.url;
    }
    async function fetchPoster(row: Row): Promise<void> {
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 12_000);
        try {
            const response = await fetch(row.item.url, { credentials: "include", signal: controller.signal });
            if (!response.ok || !bunkrFileURL(response.url || row.item.url)) throw new Error("File page unavailable");
            const url = parseBunkrPoster(await response.text(), row.item.url);
            if (url) { posters[row.item.url] = { url }; savePosters(); setPoster(row, { url }); row.posterReady = true; }
        } catch { /* Retain the album thumbnail; a revisit can retry. */ }
        finally { clearTimeout(deadline); row.posterBusy = false; }
    }
    function drainPosters(): void {
        while (!hidden && posterRequests < 3 && posterQueue.length) {
            const row = posterQueue.shift()!;
            if (!row.visible || row.posterReady) { row.posterBusy = false; continue; }
            posterRequests++; void fetchPoster(row).finally(() => { posterRequests--; drainPosters(); });
        }
    }
    function activate(row: Row): void {
        if (hidden) return;
        row.control.resume();
        if (!row.posterReady && !row.posterBusy) { row.posterBusy = true; posterQueue.push(row); drainPosters(); }
    }
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            const row = rows.get((entry.target as HTMLElement).dataset.fileURL ?? ""); if (!row) continue;
            row.visible = entry.isIntersecting; if (row.visible) activate(row); else row.control.suspend();
        }
    }, { rootMargin: "600px 0px" });
    function makeRow(item: AlbumItem): Row {
        const element = document.createElement("article"); element.className = "album-row"; element.dataset.fileURL = item.url;
        const link = document.createElement("a"); link.className = "album-preview"; link.href = item.url; link.setAttribute("aria-label", item.title);
        const image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async"; link.append(image);
        image.onload = () => sizeImage(image, image.naturalWidth, image.naturalHeight);
        const details = document.createElement("div"); details.className = "album-details";
        const name = document.createElement("a"); name.className = "album-name"; name.href = item.url; name.textContent = item.title;
        const metadata = document.createElement("p"); metadata.className = "album-metadata"; metadata.textContent = [item.size, item.date].filter(Boolean).join(" · ");
        const button = document.createElement("button"); button.className = "album-download"; button.type = "button";
        const control = new BunkrDownload(new URL(item.url), () => {
            button.textContent = control.label ?? "Download to PC"; button.dataset.state = control.state; button.setAttribute("aria-busy", String(control.submitting));
        }, true);
        button.textContent = control.label ?? "Download to PC"; button.addEventListener("click", () => void control.activate());
        details.append(name, metadata, button); element.append(link, details);
        const row = { element, image, control, item, visible: false, posterReady: false, posterBusy: false };
        const poster = posters[item.url];
        if (poster?.url) { setPoster(row, poster); row.posterReady = true; } else if (item.thumbnail) image.src = item.thumbnail;
        image.addEventListener("error", () => { if (item.thumbnail && image.src !== item.thumbnail) image.src = item.thumbnail; else image.removeAttribute("src"); });
        return row;
    }
    function render(album: Album): void {
        document.title = album.title + " | Bunkr"; title.textContent = album.title; summary.textContent = album.summary;
        const wanted = new Set(album.items.map(item => item.url));
        for (const [url, row] of rows) if (!wanted.has(url)) { observer.unobserve(row.element); row.control.dispose(); row.element.remove(); rows.delete(url); }
        for (const [index, item] of album.items.entries()) {
            let row = rows.get(item.url); if (!row) { row = makeRow(item); rows.set(item.url, row); }
            row.item = item;
            row.element.querySelector(".album-name")!.textContent = item.title;
            row.element.querySelector(".album-metadata")!.textContent = [item.size, item.date].filter(Boolean).join(" · ");
            if (list.children[index] !== row.element) list.insertBefore(row.element, list.children[index] ?? null);
            observer.observe(row.element);
        }
        status.textContent = album.items.length ? "" : "No files found.";
    }
    async function load(): Promise<void> {
        try {
            const response = await fetch(pageURL, { credentials: "include" }); if (!response.ok) throw new Error("Album unavailable");
            const album = parseBunkrAlbum(await response.text(), pageURL);
            try { sessionStorage.setItem(albumKey, JSON.stringify(album)); } catch { /* Optional cache. */ }
            render(album);
        } catch {
            if (rows.size) return;
            status.textContent = "Couldn’t load the album. "; const retry = document.createElement("button"); retry.textContent = "Retry"; retry.onclick = () => void load(); status.append(retry);
        }
    }
    try { const cache = JSON.parse(sessionStorage.getItem(albumKey) ?? "null") as Album | null; if (cache && typeof cache.title === "string" && Array.isArray(cache.items) && cache.items.every(item => typeof item.title === "string" && bunkrFileURL(item.url))) render(cache); } catch { /* Invalid optional cache. */ }
    void load();
    function resume(): void { hidden = document.hidden; if (!hidden) { for (const row of rows.values()) if (row.visible) activate(row); drainPosters(); } }
    window.addEventListener("pagehide", () => { hidden = true; for (const row of rows.values()) row.control.suspend(); });
    for (const event of ["pageshow", "online", "focus"]) window.addEventListener(event, resume);
    document.addEventListener("visibilitychange", () => { hidden = document.hidden; if (hidden) { for (const row of rows.values()) row.control.suspend(); } else resume(); });
}
