import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { porntrexGet } from "../upload/porntrexKeepalive.js";

const run = promisify(execFile);

// The player's qualities: video_url, video_alt_url, video_alt_url2… each with a
// `<key>_text` label ("720p HD", "1080p FHD"). Porntrex scales by height, so a
// portrait "720p" is 406x720; only the probe says what a tier really holds.
export function playerTiers(html: string): Array<{ label: string; url: string }> {
    const fields = new Map([...html.matchAll(/\b(video_(?:alt_)?url\d*(?:_text)?)\s*:\s*'([^']*)'/g)].map((match) => [match[1], match[2]]));
    return [...fields].filter(([key, value]) => !key.endsWith("_text") && value.includes("/get_file/"))
        .map(([key, url]) => ({ label: fields.get(`${key}_text`) ?? "", url }))
        .sort((left, right) => Number(right.label.match(/(\d{3,4})p/)?.[1] ?? 0) - Number(left.label.match(/(\d{3,4})p/)?.[1] ?? 0));
}

async function probe(url: string): Promise<string | null> {
    try {
        const { stdout } = await run("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-probesize", "2000000", "-analyzeduration", "2000000",
            "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", url], { timeout: 30_000 });
        return stdout.trim() || null;
    } catch { return null; }
}

// `npm run ptrex:tiers [-- --record FILE]`: for every published Porntrex upload,
// the quality tiers offered and the probed size of the top one. Read-only on
// the shared session; --record appends one JSON line per run.
export async function porntrexTiersReport(config: PipelineConfig, recordFile: string | null, now = new Date()): Promise<unknown> {
    const sessionFile = config.porntrexSessionPath;
    if (!sessionFile) throw new Error("No Porntrex session file is configured");
    const database = new PipelineDatabase(config.databasePath);
    let uploads;
    try { uploads = database.listPorntrexUploads(500).filter((upload) => upload.remoteId); } finally { database.close(); }
    const videos = [];
    for (const upload of uploads) {
        const edit = await porntrexGet(sessionFile, `/edit-video/${upload.remoteId}/`);
        const link = edit.html.match(new RegExp(`href="https://www\\.porntrex\\.com(/video/${upload.remoteId}/[^"]+)"`))?.[1];
        if (!link) { videos.push({ recording: upload.recordingId, remoteId: upload.remoteId, status: edit.status === 200 ? "no public link yet" : "processing or gone" }); continue; }
        const tiers = playerTiers((await porntrexGet(sessionFile, link)).html);
        videos.push({
            recording: upload.recordingId,
            remoteId: upload.remoteId,
            hoursSinceUpload: Math.round((now.getTime() - Date.parse(upload.startedAt)) / 36e5 * 10) / 10,
            tiers: tiers.map((tier) => tier.label),
            top: tiers[0] ? await probe(new URL(tiers[0].url).href) : null,
        });
    }
    const published = videos.filter((video) => "tiers" in video) as Array<{ tiers: string[]; top: string | null }>;
    const pixels = (size: string | null) => size ? size.split("x").map(Number).reduce((a, b) => a * b, 1) : 0;
    const summary = {
        at: now.toISOString(),
        published: published.length,
        topTiers: Object.fromEntries([...Map.groupBy(published, (video) => video.tiers[0] ?? "none")].map(([label, rows]) => [label, rows.length])),
        topSizes: Object.fromEntries([...Map.groupBy(published, (video) => video.top ?? "unprobed")].map(([size, rows]) => [size, rows.length])),
        anyTier1080OrAbove: published.some((video) => video.tiers.some((label) => Number(label.match(/(\d{3,4})p/)?.[1] ?? 0) >= 1080)),
        anyFullHdPixels: published.some((video) => pixels(video.top) >= 1920 * 1080 * 0.995),
    };
    if (recordFile) {
        await mkdir(path.dirname(recordFile), { recursive: true });
        await appendFile(recordFile, `${JSON.stringify({ ...summary, videos })}\n`);
    }
    return { ...summary, videos };
}
