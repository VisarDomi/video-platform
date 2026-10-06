import fs from "fs/promises";
import path from "path";

const SESSION_DIR = "/home/visar/.local/share/video-services/session";
// The endpoint the app blocks with and the server unblocks with
// (packages/server/src/services/tango/apiClient.ts). The older
// DELETE /proxycador/api/public/v1/blockList can answer 200 without unblocking.
const BLOCKLIST_URL = "https://gateway.tango.me/abregistrar/connection/v1/blocklist";
const DELAY_MS = 1000;

function usage() {
    console.log(`Usage:
  node scripts/tango-unblock-blocklist.mjs [--account <accountId>] [--execute]

Without --account it covers every account in the current Tango block list (one request per second);
with --account only that one. Default mode is a dry run; pass --execute to unblock.`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        usage();
        process.exit(0);
    }
    const at = args.indexOf("--account");
    const account = at >= 0 ? args[at + 1] : null;
    if (at >= 0 && !account) {
        usage();
        process.exit(1);
    }
    return { execute: args.includes("--execute"), account };
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

async function requestJson(options, token) {
    const response = await fetch(BLOCKLIST_URL, {
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
    const { response, body } = await requestJson({}, token);

    if (!response.ok) {
        throw new Error(`Failed to fetch block list: HTTP ${response.status}`);
    }

    const users = Array.isArray(body) ? body : body?.users;
    if (!Array.isArray(users)) {
        throw new Error("Unexpected block list response shape");
    }

    return users.filter((accountId) => typeof accountId === "string" && accountId.length > 0);
}

// Succeeds only when Tango confirms with error_code 0.
async function unblockAccount(accountId, token) {
    const { response, body } = await requestJson({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UNBLOCK", account_id: [accountId] }),
    }, token);
    return { ok: response.ok && body?.error_code === 0, status: response.status, body };
}

async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

const { execute, account } = parseArgs();
const token = await readTangoSessionToken();
const blockList = await fetchBlockList(token);
const targets = account ? blockList.filter((accountId) => accountId === account) : blockList;

console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    blockListCount: blockList.length,
    ...(account ? { account, blocked: targets.length === 1 } : { delayMs: DELAY_MS }),
}, null, 2));

if (!execute) {
    if (!account) {
        console.log("First 20 blocked account ids:");
        for (const accountId of blockList.slice(0, 20)) {
            console.log(accountId);
        }
    }
    console.log("Dry run only. Re-run with --execute to unblock.");
    process.exit(0);
}

let succeeded = 0;
let failed = 0;

for (let index = 0; index < targets.length; index += 1) {
    const accountId = targets[index];
    const result = await unblockAccount(accountId, token);

    if (result.ok) {
        succeeded += 1;
        console.log(`[${index + 1}/${targets.length}] unblocked ${accountId}`);
    } else {
        failed += 1;
        console.error(`[${index + 1}/${targets.length}] failed ${accountId}: HTTP ${result.status}`, result.body);
    }

    if (index + 1 < targets.length) {
        await delay(DELAY_MS);
    }
}

const remaining = new Set(await fetchBlockList(token));
console.log(JSON.stringify({
    completed: true,
    attempted: targets.length,
    succeeded,
    failed,
    stillBlocked: targets.filter((accountId) => remaining.has(accountId)).length,
}, null, 2));
