// What the form host's pages say, read from their HTML. The host's markup is stable and
// simple (see the simulator's README, "form-host"), so plain patterns read it; every reader
// returns null (or nothing) when its element is missing, and the caller decides what a
// missing element means.

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

// Named and numeric entities (the host writes "&#39;" for a quote).
export function unescapeHtml(text: string): string {
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (whole, decimal?: string, hex?: string, name?: string) =>
        decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name!.toLowerCase()] ?? whole);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The value of the first input named `name` (hidden fields, the title input).
export function inputValue(page: string, name: string): string | null {
    const match = new RegExp(`<input[^>]*\\bname="${escapeRegExp(name)}"[^>]*\\bvalue="([^"]*)"`).exec(page);
    return match ? unescapeHtml(match[1]) : null;
}

export function inputValues(page: string, name: string): string[] {
    return [...page.matchAll(new RegExp(`<input[^>]*\\bname="${escapeRegExp(name)}"[^>]*\\bvalue="([^"]*)"`, "g"))].map((m) => unescapeHtml(m[1]));
}

// The upload page's own settings: the chunk size and the two upload addresses.
export interface UploadContext {
    readonly uploadChunkSize: number;
    readonly uploadUrl: string;
    readonly finishUrl: string;
}

export function uploadContext(page: string): UploadContext | null {
    const match = /window\.pageContext = (\{.*?\});<\/script>/s.exec(page);
    if (!match) return null;
    const context = JSON.parse(match[1]) as { upload_chunk_size?: unknown; upload_url?: unknown; finish_url?: unknown };
    if (typeof context.upload_chunk_size !== "number" || context.upload_chunk_size < 1
        || typeof context.upload_url !== "string" || typeof context.finish_url !== "string") return null;
    return { uploadChunkSize: context.upload_chunk_size, uploadUrl: context.upload_url, finishUrl: context.finish_url };
}

// Whether a page is the signed-in upload form (the file input) or a login form.
export const hasUploadForm = (page: string): boolean => /<input type="file" name="content"/.test(page);
export const hasLoginForm = (page: string): boolean => /\bname="pass"/.test(page);

// The visible error lines of a form ("generic-error"), as text.
export function genericErrors(page: string): string[] {
    return [...page.matchAll(/<(?:div|p) class="generic-error"(?: style="[^"]*")?>(.*?)<\/(?:div|p)>/gs)]
        .map((m) => unescapeHtml(m[1].replace(/<[^>]+>/g, "")).trim()).filter(Boolean);
}

// The words the host refused or replaced: "Sorry, '<word>' is not allowed here."
export function refusedWords(text: string): string[] {
    return [...new Set([...text.matchAll(/Sorry, '([^'\n]+)' is not allowed here\./g)].map((m) => m[1]))];
}

// "Limited visibility due to : <reason>"
export function limitedVisibility(text: string): string | null {
    return /Limited visibility due to : ([^<\n]+)/.exec(text)?.[1].trim() ?? null;
}

// One row of the "My videos" list.
export interface ListedVideo {
    readonly id: string;
    readonly title: string;
    // The published page, relative to the host; null while processing or after a failure.
    readonly path: string | null;
    readonly processing: boolean;
    readonly failed: boolean;
    readonly limited: string | null;
}

// One page of the list block, with its place among the pages.
export interface ListPage {
    readonly page: number;
    readonly pages: number;
    readonly videos: readonly ListedVideo[];
}

export function listPage(block: string): ListPage | null {
    const head = /<div id="list_videos_my_uploaded_videos" data-page="(\d+)" data-pages="(\d+)">/.exec(block);
    if (!head) return null;
    const videos: ListedVideo[] = [];
    // A row holds no nested div, so it ends at the first closing one.
    for (const row of block.matchAll(/<div class="item( processing| error)?" data-item-id="(\d+)">(.*?)<\/div>/gs)) {
        const [, kind, id, inner] = row;
        const link = /<p class="inf"><a href="([^"]*)">(.*?)<\/a><\/p>/s.exec(inner);
        const span = /<p class="inf"><span class="title">(.*?)<\/span><\/p>/s.exec(inner);
        const title = unescapeHtml((link?.[2] ?? span?.[1] ?? "").trim());
        videos.push({
            id, title,
            path: link && link[1] ? unescapeHtml(link[1]) : null,
            processing: kind === " processing", failed: kind === " error",
            limited: limitedVisibility(inner),
        });
    }
    return { page: Number(head[1]), pages: Number(head[2]), videos };
}

// The edit page of a published video: what the host stored, and its canonical address.
export interface EditPage {
    readonly url: string;
    readonly title: string;
    readonly description: string;
    readonly tags: string[];
    readonly categoryIds: string[];
    readonly notices: string[];
    readonly visibility: "public" | "private" | null;
}

export function editPage(page: string): EditPage | null {
    const url = /<a class="video-link" href="([^"]+)">/.exec(page)?.[1];
    if (!url) return null;
    const description = /<textarea id="edit_video_description" name="description">(.*?)<\/textarea>/s.exec(page)?.[1] ?? "";
    const visibility = /<p class="visibility" data-visibility="(public|private)">/.exec(page)?.[1] as "public" | "private" | undefined;
    return {
        url: unescapeHtml(url),
        title: inputValue(page, "title") ?? "",
        description: unescapeHtml(description),
        tags: (inputValue(page, "tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
        categoryIds: inputValues(page, "category_ids[]"),
        notices: [...page.matchAll(/<div class="notice">(.*?)<\/div>/gs)].map((m) => unescapeHtml(m[1]).trim()),
        visibility: visibility ?? null,
    };
}

// The player's renditions on a video page, highest first: { label, url }.
export function renditions(page: string): Array<{ label: string; url: string }> {
    const match = /var flashvars = (\{.*?\});<\/script>/s.exec(page);
    if (!match) return [];
    const vars = JSON.parse(match[1]) as Record<string, string>;
    const keys = Object.keys(vars).filter((key) => /^video_(?:url|alt_url\d*)$/.test(key));
    return keys.map((key) => ({ url: vars[key], label: vars[`${key}_text`] ?? "" })).reverse();
}
