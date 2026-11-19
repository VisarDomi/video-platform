// Pinning tests: which download-list lines count as targets, how a recording
// folder names its streamer, and how the TsLive requests are authorized from the
// token file. A list line that stops counting ends that streamer's live capture
// at once; a changed token path or field turns every TsLive request into a 401.
//
// Two parsers read the same lists today: the downloader's target managers (what
// is recorded) and shared/streamerTarget.ts (the server's list, member and
// remove routes). Both are pinned on the same fixtures, including where they
// disagree. Change them only on purpose.
import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The list paths and the token path are fixed when the modules load.
const sandbox = await mkdtemp(path.join(os.tmpdir(), "pins-lists-"));
process.env.HOME = path.join(sandbox, "home");
process.env.VIDEO_SERVICES_DATA_ROOT = path.join(sandbox, "data");
process.env.VIDEO_DOWNLOADS_ROOT = path.join(sandbox, "downloads");
const lists = path.join(sandbox, "data", "download-lists");
await mkdir(lists, { recursive: true });
test.after(() => rm(sandbox, { recursive: true, force: true }));

const { parseStreamerTargetLine, extractRecordingIdentifier, readTokens } = await import("shared");
const { TsLiveTargetManager } = await import("../dist/services/tslive/discovery/targetManager.js");
const { ScTargetManager } = await import("../dist/services/fmp4/discovery/targetManager.js");
const { createLadderTargetManager } = await import("../dist/services/ladder/discovery/targetManager.js");
const { formatDownloadDirName } = await import("../dist/services/core/downloadUtils.js");
const { ApiClient } = await import("../dist/services/tslive/api/apiClient.js");

// Synthetic fixtures: comments, blank lines, tabs, trailing slashes, bare
// usernames and IDs, query strings, CRLF endings, repeats.
const TSLIVE_LIST = [
    "# TsLive list (synthetic)",
    "",
    "https://ts-live.example/acctA synthetic_a",
    "https://ts-live.example/acctB/\tsynthetic_b",
    "   https://ts-live.example/acctC   synthetic c spaced  ",
    "https://ts-live.example/acctD",
    "https://ts-live.example/acctD2/",
    "https://ts-live.example/acctE?ref=share synthetic_e",
    "acctF synthetic_f",
    "https://ts-live.example/acctG synthetic_g",
    "https://ts-live.example/acctH synthetic_h\r",
    "#https://ts-live.example/acctI synthetic_i",
    "https://ts-live.example/acct.J synthetic_j",
    "https://ts-live.example/acctA renamed_a",
    "",
].join("\n");
const FMP4_LIST = [
    "# FMP4 list (synthetic)",
    "",
    "https://fmp4-live.example/synthetic_one 30000001",
    "https://fmp4-live.example/synthetic_two/ 30000002",
    "https://fmp4-live.example/synthetic_three?utm=x 30000003",
    "https://fmp4-live.example/synthetic_four",
    "synthetic_bare",
    "synthetic_bare_with_id 30000006",
    "https://fmp4-live.example/synthetic_tab\t30000007",
    "https://fmp4-live.example/synthetic_sub 30000008",
    "https://fmp4-live.example/synthetic_nine notanumber",
    "\t# indented comment",
    "https://fmp4-live.example/synthetic_ten 30000010\r",
    "https://fmp4-live.example/synthetic_eleven/profile 30000011",
    "",
].join("\n");
const LADDER_LIST = [
    "# LADDER list (synthetic)",
    "",
    "10000001",
    "https://ladder-live.example/10000002/",
    "https://ladder-live.example/10000003",
    "https://ladder-live.example/10000004/?utm=x",
    "http://ladder-live.example/10000005/",
    "https://ladder-live.example/en/10000006/",
    "ladder-live.example/10000007",
    "  10000008\t",
    "synthetic_name",
    "https://ladder-live.example/10000009/ trailing words",
    "10000010\r",
    "",
].join("\n");

const sharedParse = (provider, text) => text.split("\n")
    .map((line) => parseStreamerTargetLine(provider, line))
    .filter(Boolean)
    .map(({ id, label }) => ({ id, label }));

async function loadedTargets(t, file, content, create) {
    await writeFile(path.join(lists, file), content);
    const manager = create();
    t.after(() => manager.close());
    return manager.getTargets();
}

test("pin: TsLive list lines, downloader vs shared parser", async (t) => {
    assert.deepEqual(await loadedTargets(t, "tslive.txt", TSLIVE_LIST, () => TsLiveTargetManager.create()), [
        { accountId: "acctA", alias: "renamed_a" }, // a repeated ID: the last line wins, first position kept
        { accountId: "acctB", alias: "synthetic_b" },
        { accountId: "acctC", alias: "synthetic c spaced" },
        { accountId: "acctH", alias: "synthetic_h" },
    ]);
    assert.deepEqual(sharedParse("tslive", TSLIVE_LIST), [
        { id: "acctA", label: "synthetic_a" },
        { id: "acctC", label: "synthetic c spaced" },
        { id: "acctE?ref=share", label: "synthetic_e" },
        { id: "acctH", label: "synthetic_h" },
        { id: "acct.J", label: "synthetic_j" },
        { id: "acctA", label: "renamed_a" },
    ]);
    // Where they disagree today:
    //   tab separator: downloader yes, shared no (it splits on a space only);
    //   query string: downloader no, shared yes with the query in the ID;
    //   "." in the ID: downloader no, shared yes.
    // Both skip: no alias, bare IDs, ts-live.example, comments.
});

test("pin: FMP4 list lines, downloader vs shared parser", async (t) => {
    assert.deepEqual(await loadedTargets(t, "fmp4.txt", FMP4_LIST, () => ScTargetManager.create()), [
        { username: "synthetic_one", roomId: "30000001" },
        { username: "synthetic_two", roomId: "30000002" },
        { username: "synthetic_three", roomId: "30000003" },
        { username: "synthetic_four", roomId: "" },
        { username: "synthetic_bare", roomId: "" },
        { username: "synthetic_bare_with_id 30000006", roomId: "" },
        { username: "synthetic_tab\t30000007", roomId: "" },
        { username: "synthetic_sub", roomId: "30000008" },
        { username: "synthetic_nine", roomId: "notanumber" },
        { username: "synthetic_ten", roomId: "30000010" },
        { username: "synthetic_eleven", roomId: "30000011" },
    ]);
    assert.deepEqual(sharedParse("fmp4", FMP4_LIST), [
        { id: "30000001", label: "synthetic_one" },
        { id: "30000002", label: "synthetic_two" },
        { id: "30000003", label: "synthetic_three?utm=x" },
        { id: "synthetic_four", label: "synthetic_four" },
        { id: "synthetic_tab\t30000007", label: "synthetic_tab\t30000007" },
        { id: "30000010", label: "synthetic_ten" },
        { id: "30000011", label: "synthetic_eleven/profile" },
    ]);
    // Where they disagree today:
    //   bare usernames (with or without an ID): downloader keeps them (no room ID), shared skips;
    //   subdomains (fmp4-live.example): downloader yes, shared no;
    //   non-numeric room ID: downloader keeps it, shared skips;
    //   query or extra path after the username: downloader strips it, shared keeps it in the label;
    //   a username without a room ID: downloader has room ID "", shared uses the username as the ID.
});

test("pin: LADDER list lines, downloader vs shared parser", async (t) => {
    assert.deepEqual(await loadedTargets(t, "ladder.txt", LADDER_LIST, () => createLadderTargetManager()), [
        "10000001", "10000002", "10000003", "10000004", "10000005", "10000007", "10000008", "10000009", "10000010",
    ]);
    assert.deepEqual(sharedParse("ladder", LADDER_LIST), [
        { id: "10000002", label: "10000002" },
        { id: "10000003", label: "10000003" },
    ]);
    // Where they disagree today: the downloader records bare IDs, http://, a
    // missing scheme, a query string and trailing words after the ID; the shared
    // parser accepts only https://ladder-live.example/<digits>[/]. Both skip /en/<id>.
});

test("pin: folder name 'YYYY-MM-DD HHMMSS <alias>' (local time) and the identity read back from it", () => {
    const startedAt = new Date(2026, 2, 4, 5, 6, 7);
    for (const alias of ["synthetic_alias", "10000001", "synthetic c spaced"]) {
        const folder = formatDownloadDirName(alias, startedAt);
        assert.equal(folder, `2026-03-04 050607 ${alias}`);
        assert.equal(extractRecordingIdentifier(folder), alias);
    }
});

// The token file path is pinned in shared/test/pins.test.mjs; this follows the
// same file through to the request headers the downloader sends.
async function writeSession(t, session) {
    const requested = [];
    const readFile = fsPromises.readFile;
    t.mock.method(fsPromises, "readFile", async (file, ...rest) => {
        requested.push(String(file));
        return await readFile.call(fsPromises, file, ...rest);
    });
    await readTokens();
    t.mock.restoreAll();
    await mkdir(path.dirname(requested[0]), { recursive: true });
    await writeFile(requested[0], JSON.stringify(session));
}

test("pin: TsLive request headers built from the token file", async (t) => {
    await writeSession(t, { tsliveRT: "synthetic-rt", tsliveST: "synthetic-st", tt: "synthetic-tt",
        ttu: "synthetic-ttu", tte: "1800000600", lastWriteMs: 1 });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? null });
        return String(url).includes("byEncryptedAccountIds")
            ? Response.json({ code: "OK", totalCount: 0 })
            : new Response("#EXTM3U\n");
    });
    const api = new ApiClient(); // the default reader: shared readTokens
    await api.getLiveStreamsByAccountIds(["acctA"]);
    await api.getMasterList("https://cdn.tslive.example.test/master.m3u8");
    const session = api.createDownloadSession();
    await session.fetchPlaylist("https://cdn.tslive.example.test/live.m3u8");
    await session.fetchSegment("https://cdn.tslive.example.test/1.ts");
    const streamCookie = { cookie: "tt=synthetic-tt;ttu=synthetic-ttu;tte=1800000600" };
    assert.deepEqual(requests, [
        { url: "https://ts-live.example/stream/social/v2/list/byEncryptedAccountIds?pageSize=1", method: "POST",
            headers: { cookie: "TsLive-ST=synthetic-st", Accept: "application/json", "Content-Type": "application/json" } },
        { url: "https://cdn.tslive.example.test/master.m3u8", method: "GET", headers: streamCookie },
        { url: "https://cdn.tslive.example.test/live.m3u8", method: "GET", headers: streamCookie },
        // Segments carry no cookie.
        { url: "https://cdn.tslive.example.test/1.ts", method: "GET", headers: null },
    ]);
});

test("pin: no TsLive request is sent when its tokens are missing", async (t) => {
    await writeSession(t, { tsliveST: "synthetic-st" }); // no tt/ttu/tte
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url) => { requests.push(String(url)); return Response.json({ code: "OK", totalCount: 0 }); });
    const api = new ApiClient();
    assert.equal(await api.getMasterList("https://cdn.tslive.example.test/master.m3u8"), null);
    assert.equal(await api.createDownloadSession().fetchPlaylist("https://cdn.tslive.example.test/live.m3u8"), null);
    assert.deepEqual(requests, []);
    await writeSession(t, { tt: "synthetic-tt", ttu: "synthetic-ttu", tte: "1800000600" }); // no tsliveST: nothing is read
    assert.equal(await api.getLiveStreamsByAccountIds(["acctA"]), null);
    assert.equal(await api.createDownloadSession().fetchPlaylist("https://cdn.tslive.example.test/live.m3u8"), null);
    assert.deepEqual(requests, []);
});
