// What Porntrex stored for a published video, read from its edit page, and
// whether it matches the metadata the pipeline submitted. Porntrex adds its
// own tags derived from the title and description, so ours must be present,
// not exclusive.
export interface StoredPorntrexMetadata {
    readonly title: string;
    readonly description: string;
    readonly tags: readonly string[];
    readonly categories: readonly string[];
    readonly categoryIds: readonly string[];
}

export const PORNTREX_WEBCAM_CATEGORY = "21";

function decode(text: string): string {
    return text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&quot;/g, "\"").replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attribute(html: string, id: string, name: string): string | null {
    const tag = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0];
    const value = tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    return value === undefined ? null : decode(value);
}

const list = (value: string | null) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export function parsePorntrexEditPage(html: string): StoredPorntrexMetadata | null {
    const title = attribute(html, "edit_video_title", "value");
    const description = html.match(/<textarea[^>]*\bid="edit_video_description"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
    if (title === null || description === undefined) return null;
    return {
        title,
        description: decode(description),
        tags: list(attribute(html, "edit_video_tags", "value")),
        categories: list(attribute(html, "edit_video_categories", "value")),
        categoryIds: [...html.matchAll(/name="category_ids\[\]"[^>]*value="(\d+)"/g)].map((match) => match[1]),
    };
}

// The differing middle of two texts, by whole words: Porntrex silently
// replaces some words (seen: "choker" became "flowers") instead of refusing.
export function changedText(expected: string, stored: string): { from: string; to: string } {
    const left = expected.split(/(\s+)/);
    const right = stored.split(/(\s+)/);
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    let end = 0;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    return { from: left.slice(start, left.length - end).join("").trim(), to: right.slice(start, right.length - end).join("").trim() };
}

export function comparePorntrexMetadata(
    expected: { readonly title: string; readonly description: string; readonly tags: readonly string[] },
    stored: StoredPorntrexMetadata,
): { ok: boolean; problems: string[] } {
    const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
    const problems: string[] = [];
    if (stored.title !== expected.title) problems.push("title differs");
    if (normalize(stored.description) !== normalize(expected.description)) {
        const change = changedText(normalize(expected.description), normalize(stored.description));
        problems.push(`description differs: "${change.from}" became "${change.to}"`);
    }
    const have = new Set(stored.tags.map((tag) => tag.toLowerCase()));
    const missing = expected.tags.filter((tag) => !have.has(tag.toLowerCase()));
    if (missing.length) problems.push(`missing tags: ${missing.join(", ")}`);
    if (!stored.categoryIds.includes(PORNTREX_WEBCAM_CATEGORY)) problems.push(`Webcam category missing (has: ${stored.categories.join(", ") || "none"})`);
    return { ok: problems.length === 0, problems };
}

export interface ListedPorntrexUpload { readonly remoteId: string; readonly title: string; readonly processing: boolean }

// Rows of "My Videos" (first page holds the newest uploads).
export function parsePorntrexUploadsList(html: string): ListedPorntrexUpload[] {
    return [...html.matchAll(/class="([^"]*\bvideo-item\b[^"]*)"\s+data-item-id="(\d+)"[\s\S]*?<p class="inf"><a\b[^>]*>([^<]*)</g)]
        .map((match) => ({ remoteId: match[2], title: decode(match[3]).trim(), processing: /\bprocessing\b/.test(match[1]) }));
}
