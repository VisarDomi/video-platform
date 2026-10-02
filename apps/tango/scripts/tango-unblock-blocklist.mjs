import fs from "fs/promises";
import path from "path";

const SESSION_DIR = "/home/visar/.local/share/video-services/session";
const API_BASE = "https://gateway.tango.me/proxycador/api/public/v1";
const DELAY_MS = 1000;

function usage() {
    console.log(`Usage:
  node scripts/tango-unblock-blocklist.mjs
  node scripts/tango-unblock-blocklist.mjs --execute

Default mode is a dry run. Pass --execute to unblock every account in the current Tango block list, one request per second.`);
}

function parseArgs() {
    const args = new Set(process.argv.slice(2));
    if (args.has("--help") || args.has("-h")) {
        usage();
        process.exit(0);
    }
    return {
        execute: args.has("--execute"),
    };
}

async function readTangoSessionToken() {
    const files = await fs.readdir(SESSION_DIR);

    for (const file of files.filter((name) => name.endsWith(".json"))) {
        const data = JSON.parse(await fs.readFile(path.join(SESSION_DIR, file), "utf8"));
        if (data.tangoST) {
            return data.tangoST;
        }
    }

    throw new Error(`No Tango-ST found in ${SESSION_DIR}`);
}

async function requestJson(url, options, token) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            Cookie: `Tango-ST=${token}`,
            ...(options?.headers ?? {}),
        },
    });
    const text = await response.text();
    let body = null;

    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }

    return { response, body };
}

async function fetchBlockList(token) {
    const { response, body } = await requestJson(`${API_BASE}/blockList`, {}, token);

    if (!response.ok) {
        throw new Error(`Failed to fetch block list: HTTP ${response.status}`);
    }

    if (!Array.isArray(body)) {
        throw new Error("Unexpected block list response shape");
    }

    return body.filter((accountId) => typeof accountId === "string" && accountId.length > 0);
}

async function unblockAccount(accountId, token) {
    return requestJson(`${API_BASE}/blockList?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" }, token);
}

async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

const { execute } = parseArgs();
const token = await readTangoSessionToken();
const blockList = await fetchBlockList(token);

console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    blockListCount: blockList.length,
    delayMs: DELAY_MS,
}, null, 2));

if (!execute) {
    console.log("First 20 blocked account ids:");
    for (const accountId of blockList.slice(0, 20)) {
        console.log(accountId);
    }
    console.log("Dry run only. Re-run with --execute to unblock.");
    process.exit(0);
}

let succeeded = 0;
let failed = 0;

for (let index = 0; index < blockList.length; index += 1) {
    const accountId = blockList[index];
    const { response, body } = await unblockAccount(accountId, token);

    if (response.ok) {
        succeeded += 1;
        console.log(`[${index + 1}/${blockList.length}] unblocked ${accountId}`);
    } else {
        failed += 1;
        console.error(`[${index + 1}/${blockList.length}] failed ${accountId}: HTTP ${response.status}`, body);
    }

    if (index + 1 < blockList.length) {
        await delay(DELAY_MS);
    }
}

console.log(JSON.stringify({
    completed: true,
    attempted: blockList.length,
    succeeded,
    failed,
}, null, 2));
