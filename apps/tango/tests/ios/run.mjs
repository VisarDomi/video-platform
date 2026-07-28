#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const bridgeOrigin = process.env.IOS_DEBUG_ORIGIN ?? "https://127.0.0.1:36666";
const phasePauseMs = Math.max(1000, Number(process.env.IOS_TEST_SETTLE_MS ?? 1000));
const commandTimeoutMs = Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000);
const clientTimeoutMs = Number(process.env.IOS_TEST_CLIENT_TIMEOUT_MS ?? 45000);
const connectionTimeoutMs = Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120000);
const agent = new https.Agent({ rejectUnauthorized: false });
let ownedServer = null;
let claimedClient = null;
let lastNavigationAt = 0;

function sleep(ms) {
    return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function request(path, { method = "GET", body } = {}) {
    return new Promise((resolveRequest, rejectRequest) => {
        const url = new URL(path, bridgeOrigin);
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = https.request(url, {
            method,
            agent,
            headers: payload ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
            } : undefined,
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    rejectRequest(new Error(`${method} ${url.pathname}: HTTP ${response.statusCode}: ${text}`));
                    return;
                }
                if (!text) {
                    resolveRequest(null);
                    return;
                }
                try {
                    resolveRequest(JSON.parse(text));
                } catch {
                    rejectRequest(new Error(`${method} ${url.pathname}: invalid JSON response`));
                }
            });
        });
        req.on("error", rejectRequest);
        if (payload) req.write(payload);
        req.end();
    });
}

async function ensureServer() {
    try {
        await request("/__debug_state");
        return;
    } catch {
        ownedServer = spawn("python3", [resolve(here, "bridge_server.py")], {
            cwd: root,
            stdio: ["ignore", "ignore", "inherit"],
        });
    }
    for (let attempt = 0; attempt < 30; attempt++) {
        if (ownedServer.exitCode !== null) {
            throw new Error("The gallery iOS bridge failed to start. Run `npm run tests:setup`.");
        }
        try {
            await request("/__debug_state");
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error("Timed out starting the gallery iOS bridge.");
}

async function state() {
    return request("/__debug_state");
}

async function waitForDebugger() {
    const info = await request("/__debug_info");
    console.log(`Waiting for iPhone debugger on port ${new URL(bridgeOrigin).port}.`);
    console.log(`If needed, install:\n  ${info.debuggerUrl}`);
    const deadline = Date.now() + connectionTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const now = Date.now() / 1000;
        if (snapshot.clients.some(client => now - client.lastSeen < 3)) return;
        await sleep(250);
    }
    throw new Error(
        "No gallery-reader debugger is connected.\n" +
        `Install it from ${info.debuggerUrl}, then keep Safari foregrounded.`,
    );
}

function runLocalCommand(commandName, args) {
    const completed = spawnSync(commandName, args, { cwd: root, stdio: "inherit" });
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
        throw new Error(`${commandName} ${args.join(" ")} failed with exit code ${completed.status}`);
    }
}

function checkAndBuild() {
    runLocalCommand("npx", ["tsc", "--noEmit"]);
    runLocalCommand("npx", ["vite", "build"]);
}

async function postCommand(target, code) {
    const posted = await request("/__debug_command", {
        method: "POST",
        body: { target, code },
    });
    return posted.id;
}

async function waitForResult(commandId) {
    const deadline = Date.now() + commandTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const result = [...snapshot.results].reverse().find(item => item.commandId === commandId);
        if (result) {
            if (!result.ok) {
                const detail = result.error?.message ?? JSON.stringify(result.error);
                throw new Error(`Remote command ${commandId} failed: ${detail}`);
            }
            return result.result;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for remote command ${commandId}`);
}

async function command(target, code, { expectResult = true } = {}) {
    const id = await postCommand(target, code);
    return expectResult ? waitForResult(id) : id;
}

async function foregroundClient() {
    const snapshot = await state();
    const now = Date.now() / 1000;
    const active = snapshot.clients.filter(client => now - client.lastSeen < 3);
    if (!active.length) throw new Error("No active iPhone debugger client");
    const id = await postCommand("*", `
        return {
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            href: location.href,
        };
    `);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const current = await state();
        const results = current.results.filter(result => result.commandId === id && result.ok);
        const visible = results.find(result =>
            result.result?.visibilityState === "visible" && result.result?.hasFocus
        ) ?? results.find(result => result.result?.visibilityState === "visible");
        if (visible) {
            const client = active.find(item => item.client === visible.client);
            if (client) return client;
        }
        await sleep(100);
    }
    if (active.length === 1) return active[0];
    throw new Error(`Could not identify foreground Safari tab among ${active.length} clients`);
}

function assertClaimableClient(client, targetUrls) {
    const hostname = new URL(client.href).hostname;
    const allowedHosts = new Set([
        "example.com",
        ...Object.values(targetUrls).map(url => new URL(url).hostname),
    ]);
    if (!allowedHosts.has(hostname)) {
        throw new Error(
            "The foreground Safari tab is unrelated to this test suite.\n" +
            "Open https://example.com/ or one of the frozen target sites, then rerun.\n" +
            `Foreground tab is currently: ${client.href}`,
        );
    }
}

function urlsMatch(actualText, expectedText) {
    try {
        const actual = new URL(actualText);
        const expected = new URL(expectedText);
        return actual.hostname === expected.hostname
            && actual.pathname === expected.pathname
            && actual.search === expected.search
            && actual.hash === expected.hash;
    } catch {
        return false;
    }
}

async function waitForActiveClient(predicate, description) {
    const deadline = Date.now() + clientTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const now = Date.now() / 1000;
        const match = [...snapshot.clients]
            .filter(client => now - client.lastSeen < 3 && predicate(client))
            .sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (match) return match;
        await sleep(250);
    }
    throw new Error(`No active iPhone debugger client for ${description}`);
}

async function navigate(url) {
    if (!claimedClient) throw new Error("No claimed Safari tab");
    const remaining = lastNavigationAt + phasePauseMs - Date.now();
    if (remaining > 0) await sleep(remaining);
    lastNavigationAt = Date.now();
    await command(claimedClient.client, `
        const target = ${JSON.stringify(url)};
        if (location.href === target) location.reload();
        else location.href = target;
        return "navigating";
    `, { expectResult: false });
    claimedClient = await waitForActiveClient(
        client => urlsMatch(client.href, url),
        url,
    );
    return claimedClient;
}

async function waitForNavigation(predicate, description) {
    claimedClient = await waitForActiveClient(predicate, description);
    return claimedClient;
}

async function returnToExample() {
    if (!claimedClient) return;
    try {
        if (new URL(claimedClient.href).hostname === "example.com") return;
        await command(
            claimedClient.client,
            `location.href = "https://example.com/"; return "returning";`,
            { expectResult: false },
        );
        await waitForActiveClient(
            client => new URL(client.href).hostname === "example.com",
            "example.com cleanup",
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Could not return Safari to example.com: ${message}`);
    }
}

async function showPhase(text, stateName = "running") {
    if (!claimedClient) return;
    await command(claimedClient.client, `
        globalThis.__galleryReaderTestPhase?.(
            ${JSON.stringify(text)},
            ${JSON.stringify(stateName)}
        );
        return true;
    `);
    await sleep(phasePauseMs);
}

function injectCode(bundle, url) {
    return `
        history.replaceState(null, "", ${JSON.stringify(url)});
        globalThis.__galleryReaderTestPhase = (text, stateName = "running") => {
            let box = document.getElementById("__gallery-reader-test-phase");
            if (!box) {
                box = document.createElement("div");
                box.id = "__gallery-reader-test-phase";
                Object.assign(box.style, {
                    position: "fixed",
                    zIndex: "2147483647",
                    top: "12px",
                    left: "12px",
                    right: "12px",
                    padding: "14px 16px",
                    borderRadius: "12px",
                    color: "white",
                    font: "700 18px/1.3 system-ui, sans-serif",
                    textAlign: "center",
                    boxShadow: "0 4px 20px #0009",
                    pointerEvents: "none",
                });
                (document.body || document.documentElement).appendChild(box);
            }
            box.style.background = stateName === "success"
                ? "#15803d"
                : stateName === "error" ? "#b91c1c" : "#1d4ed8";
            box.textContent = text;
        };
        const source = ${JSON.stringify(bundle)};
        new Function(
            source + String.fromCharCode(10) + "//# sourceURL=gallery-reader.test.user.js"
        )();
        return { injectedBytes: source.length };
    `;
}

async function inject(bundle, url = claimedClient.href) {
    const previousClient = claimedClient.client;
    const commandId = await postCommand(previousClient, injectCode(bundle, url));
    const deadline = Date.now() + clientTimeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await state();
        const now = Date.now() / 1000;
        const matchingClients = snapshot.clients
            .filter(client => now - client.lastSeen < 3 && urlsMatch(client.href, url))
            .sort((a, b) => b.lastSeen - a.lastSeen);
        const result = snapshot.results.find(item => item.commandId === commandId);
        if (result) {
            if (!result.ok) {
                const detail = result.error?.message ?? JSON.stringify(result.error);
                throw new Error(`Gallery injection failed: ${detail}`);
            }
            const sameClient = matchingClients.find(client => client.client === previousClient);
            if (sameClient) {
                claimedClient = sameClient;
                return;
            }
        }
        await sleep(250);
    }
    throw new Error(`Gallery takeover did not settle at ${url}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function waitForGallery(expectedPage) {
    return command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 360; i++) {
            const active = document.querySelector(".hs-page-active")?.textContent;
            const rows = document.querySelectorAll(".hs-row-wrap").length;
            if (active === ${JSON.stringify(String(expectedPage))} && rows > 0) break;
            await wait(250);
        }
        const active = document.querySelector(".hs-page-active")?.textContent ?? null;
        const rows = document.querySelectorAll(".hs-row-wrap").length;
        for (let i = 0; i < 120 && !document.querySelector(".hs-row .hs-thumb"); i++) {
            await wait(250);
        }
        return {
            active,
            rows,
            populatedRows: document.querySelectorAll(".hs-row").length,
            thumbs: document.querySelectorAll(".hs-thumb").length,
            pages: document.querySelectorAll(".hs-page-link").length + 1,
            href: location.href,
            input: document.getElementById("query-input")?.value ?? "",
        };
    `);
}

async function normalizePage(page) {
    const result = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const desired = ${JSON.stringify(String(page))};
        const current = document.querySelector(".hs-page-active")?.textContent;
        if (current !== desired) {
            const link = Array.from(document.querySelectorAll(".hs-page-link"))
                .find(element => element.textContent === desired);
            if (!link) return { error: "page " + desired + " link missing", current };
            link.click();
            for (let i = 0; i < 360; i++) {
                if (document.querySelector(".hs-page-active")?.textContent === desired) break;
                await wait(250);
            }
        }
        return {
            active: document.querySelector(".hs-page-active")?.textContent ?? null,
            href: location.href,
        };
    `);
    if (result.error) throw new Error(result.error);
    assert(result.active === String(page), `failed to normalize to page ${page}`);
}

async function testPagination(label) {
    await normalizePage(2);
    const result = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const run = async page => {
            const pagination = document.querySelector(".hs-page-bar-pag");
            pagination.scrollIntoView({ block: "center" });
            await wait(${phasePauseMs});
            const before = {
                historyLength: history.length,
                scrollY,
                paginationTop: pagination.getBoundingClientRect().top,
            };
            const link = Array.from(document.querySelectorAll(".hs-page-link"))
                .find(element => element.textContent === String(page));
            if (!link) return { error: "page " + page + " link missing" };
            link.click();
            for (let i = 0; i < 360; i++) {
                if (document.querySelector(".hs-page-active")?.textContent === String(page)) break;
                await wait(250);
            }
            await wait(500);
            return {
                before,
                active: document.querySelector(".hs-page-active")?.textContent ?? null,
                gridTop: document.getElementById("hs-grid")?.getBoundingClientRect().top ?? null,
                rows: document.querySelectorAll(".hs-row-wrap").length,
                href: location.href,
                historyLength: history.length,
            };
        };
        const forward = await run(3);
        const backward = await run(2);
        return { forward, backward };
    `);
    for (const [direction, step] of Object.entries(result)) {
        if (step.error) throw new Error(`${label} ${direction}: ${step.error}`);
        assert(step.active === (direction === "forward" ? "3" : "2"),
            `${label} ${direction}: wrong active page ${step.active}`);
        assert(step.rows > 0, `${label} ${direction}: no gallery rows`);
        assert(step.gridTop !== null && Math.abs(step.gridTop) <= 1,
            `${label} ${direction}: gallery top was ${step.gridTop}`);
        assert(step.historyLength === step.before.historyLength,
            `${label} ${direction}: pagination changed history length`);
    }
    await showPhase(`${label}: pagination passed`);
    return result;
}

async function snapshotLocalStorage() {
    return command(claimedClient.client, `
        const keys = ["saved_searches", "favorites", "scroll-pos-/"];
        return Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
    `);
}

async function restoreLocalStorage(snapshot) {
    if (!claimedClient) return;
    await command(claimedClient.client, `
        const snapshot = ${JSON.stringify(snapshot)};
        for (const [key, value] of Object.entries(snapshot)) {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        }
        return true;
    `);
}

async function testFavoriteToggle() {
    const before = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 120 && !document.querySelector(".hs-row"); i++) await wait(250);
        const row = document.querySelector(".hs-row-wrap");
        const button = row?.querySelector(".row-action-btn:not(.info-btn)");
        const image = row?.querySelector(".hs-thumb");
        if (!row || !button || !image) return { error: "favorite test row unavailable" };
        const gidMatch = image.onclick?.toString().match(/readerUrl\\((\\d+)/);
        const original = button.textContent;
        button.click();
        for (let i = 0; i < 40 && button.textContent === original; i++) await wait(100);
        const toggled = button.textContent;
        button.click();
        for (let i = 0; i < 40 && button.textContent !== original; i++) await wait(100);
        return {
            original,
            toggled,
            restored: button.textContent,
            rowConnected: row.isConnected,
            gidHint: gidMatch?.[1] ?? null,
        };
    `);
    if (before.error) throw new Error(before.error);
    assert(before.original !== before.toggled, "favorite button did not change");
    assert(before.restored === before.original, "favorite button did not restore");
    assert(before.rowConnected, "favorite toggle disturbed its row");
    await showPhase("Favorite toggle passed and was restored");
}

async function testBasicModal() {
    const result = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const info = document.querySelector(".info-btn");
        if (!info) return { error: "info button missing" };
        info.click();
        for (let i = 0; i < 240 && !document.querySelector(".hs-modal-ok-btn"); i++) {
            await wait(250);
        }
        const modal = document.querySelector(".hs-modal-backdrop");
        const metadata = {
            rows: modal?.querySelectorAll(".hs-modal-row").length ?? 0,
            links: modal?.querySelectorAll(".hs-modal-value-link,.hs-tag-chip").length ?? 0,
        };
        modal?.querySelector(".hs-modal-ok-btn")?.click();
        const closedByButton = !document.querySelector(".hs-modal-backdrop");
        info.click();
        for (let i = 0; i < 240 && !document.querySelector(".hs-modal-ok-btn"); i++) {
            await wait(250);
        }
        const backdrop = document.querySelector(".hs-modal-backdrop");
        backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return {
            metadata,
            closedByButton,
            closedByBackdrop: !document.querySelector(".hs-modal-backdrop"),
        };
    `);
    if (result.error) throw new Error(result.error);
    assert(result.metadata.rows > 0, "information modal has no metadata");
    assert(result.metadata.links > 0, "information modal has no related-search links");
    assert(result.closedByButton, "modal Close button failed");
    assert(result.closedByBackdrop, "modal backdrop failed");
    await showPhase("Gallery information modal passed");
}

async function testSearchState(expectedQuery) {
    const result = await command(claimedClient.client, `
        const searches = JSON.parse(localStorage.getItem("saved_searches") || "[]");
        const provider = location.hostname.includes("hitomi.la") ? "hitomi" : "imhentai";
        const entry = searches.find(item => item.provider === provider
            && item.query === ${JSON.stringify(expectedQuery)});
        const chip = Array.from(document.querySelectorAll(".hs-saved-chip"))
            .find(item => item.firstElementChild?.textContent === ${JSON.stringify(expectedQuery)});
        return {
            entry: entry ?? null,
            chip: Boolean(chip),
            input: document.getElementById("query-input")?.value ?? null,
        };
    `);
    assert(result.entry, `search was not saved for query ${expectedQuery}`);
    assert(result.entry.page === 2, `saved search page was ${result.entry.page}, expected 2`);
    assert(result.chip, "saved-search chip missing");
    assert(result.input === expectedQuery, "search input does not match URL query");
    await showPhase("Saved search and input state passed");
}

async function testReaderFlow(bundle, searchUrl, providerName) {
    await normalizePage(2);
    const searchPosition = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 120 && document.querySelectorAll(".hs-row").length < 4; i++) {
            await wait(250);
        }
        const row = document.querySelectorAll(".hs-row-wrap")[3];
        row?.scrollIntoView();
        await wait(500);
        const image = row?.querySelectorAll(".hs-thumb")[2] ?? row?.querySelector(".hs-thumb");
        return {
            available: Boolean(image),
            imageIndex: image ? Array.from(image.parentElement.children).indexOf(image) : -1,
            scrollY,
            href: location.href,
        };
    `);
    assert(searchPosition.available, `${providerName}: reader thumbnail unavailable`);
    await command(claimedClient.client, `
        const row = document.querySelectorAll(".hs-row-wrap")[3];
        const image = row?.querySelectorAll(".hs-thumb")[2] ?? row?.querySelector(".hs-thumb");
        image.click();
        return "navigating";
    `, { expectResult: false });
    await waitForNavigation(
        client => {
            const path = new URL(client.href).pathname;
            return providerName === "hitomi" ? path.startsWith("/reader/") : path.startsWith("/view/");
        },
        `${providerName} reader`,
    );
    const initialReaderUrl = claimedClient.href;
    await inject(bundle, initialReaderUrl);
    const reader = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const expected = ${searchPosition.imageIndex};
        for (let i = 0; i < 360 && !document.getElementById("#" + expected); i++) await wait(250);
        const images = document.querySelectorAll(".hs-reader-img");
        const target = document.getElementById("#" + expected);
        return {
            bodies: document.querySelectorAll(".hs-reader-body").length,
            images: images.length,
            targetTop: target?.getBoundingClientRect().top ?? null,
            expectedTop: innerHeight / 2,
            skeleton: Boolean(target?.style.aspectRatio),
        };
    `);
    assert(reader.bodies === 1 && reader.images > 1, `${providerName}: reader did not render`);
    assert(reader.skeleton, `${providerName}: reader aspect-ratio skeleton missing`);
    assert(Math.abs(reader.targetTop - reader.expectedTop) <= 2,
        `${providerName}: selected image restored at ${reader.targetTop}, expected ${reader.expectedTop}`);

    const saved = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const images = Array.from(document.querySelectorAll(".hs-reader-img"));
        const current = ${searchPosition.imageIndex};
        const target = images[Math.min(current + 1, images.length - 1)];
        for (let i = 0; i < 360 && !(target.complete && target.naturalWidth > 0); i++) await wait(250);
        const before = location.href;
        scrollTo(0, target.offsetTop - innerHeight / 2 + 1);
        for (let i = 0; i < 80 && location.href === before; i++) await wait(100);
        return {
            before,
            href: location.href,
            id: target.id,
            loaded: target.complete && target.naturalWidth > 0,
        };
    `);
    assert(saved.loaded, `${providerName}: reader target image did not load`);
    assert(saved.href !== saved.before, `${providerName}: reader URL did not save on scroll`);

    const preReloadClient = claimedClient.client;
    await command(preReloadClient, `location.reload(); return "reloading";`, { expectResult: false });
    await waitForNavigation(
        client => client.client !== preReloadClient && urlsMatch(client.href, saved.href),
        `${providerName} saved reader reload`,
    );
    await inject(bundle, saved.href);
    const restored = await command(claimedClient.client, `
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        for (let i = 0; i < 360 && !document.getElementById(${JSON.stringify(saved.id)}); i++) {
            await wait(250);
        }
        const image = document.getElementById(${JSON.stringify(saved.id)});
        return {
            top: image?.getBoundingClientRect().top ?? null,
            expectedTop: innerHeight / 2,
            href: location.href,
        };
    `);
    assert(Math.abs(restored.top - restored.expectedTop) <= 2,
        `${providerName}: saved reader restored at ${restored.top}, expected ${restored.expectedTop}`);

    await command(claimedClient.client, `history.back(); return "back";`, { expectResult: false });
    await waitForNavigation(client => {
        const actual = new URL(client.href);
        const expected = new URL(searchUrl);
        return actual.hostname === expected.hostname
            && actual.pathname === expected.pathname
            && actual.search === expected.search
            && actual.hash === expected.hash;
    }, `${providerName} Back to search`);
    const hasApp = await command(claimedClient.client,
        `return Boolean(document.getElementById("hs-grid"));`);
    if (!hasApp) await inject(bundle, searchUrl);
    const returned = await waitForGallery(2);
    assert(returned.active === "2", `${providerName}: Back restored page ${returned.active}`);
    const scroll = await command(claimedClient.client, `return { scrollY };`);
    assert(Math.abs(scroll.scrollY - searchPosition.scrollY) <= 2,
        `${providerName}: Back restored scroll ${scroll.scrollY}, expected ${searchPosition.scrollY}`);
    await showPhase(`${providerName}: reader save, reload, and Back passed`);
}

function extractEntryUrls(text) {
    const urls = [...text.matchAll(/^https?:\/\/\S+$/gm)].map(match => match[0]);
    const favorites = urls.find(url => new URL(url).hostname === "hitomi.la"
        && new URL(url).pathname === "/");
    const hitomiSearch = urls.find(url => new URL(url).hostname === "hitomi.la"
        && new URL(url).pathname !== "/");
    const imhentaiSearch = urls.find(url => new URL(url).hostname === "imhentai.xxx");
    if (!favorites || !hitomiSearch || !imhentaiSearch) {
        throw new Error("test.txt must contain Hitomi Favorites, Hitomi Search, and imhentai Search URLs");
    }
    return { favorites, hitomiSearch, imhentaiSearch };
}

function hitomiQuery(url) {
    return decodeURIComponent(new URL(url).search.slice(1));
}

function imhentaiQuery(url) {
    const parsed = new URL(url);
    const key = parsed.searchParams.get("key") ?? "";
    const languages = {
        jp: "japanese", en: "english", es: "spanish", fr: "french",
        kr: "korean", de: "german", ru: "russian",
    };
    const enabled = Object.entries(languages).filter(([code]) => parsed.searchParams.get(code) === "1");
    return enabled.length === 1
        ? (key ? `${key},language:${enabled[0][1]}` : `language:${enabled[0][1]}`)
        : key;
}

async function runFavorites(bundle, url) {
    await navigate(url);
    const backup = await snapshotLocalStorage();
    try {
        await inject(bundle, url);
        const gallery = await waitForGallery(Number(backup.favorites) || 1);
        assert(gallery.pages >= 3,
            `Favorites require at least 3 pages; phone has ${gallery.pages}`);
        assert(gallery.rows > 0 && gallery.thumbs > 0, "Favorites did not populate gallery rows");
        await showPhase(`Hitomi Favorites: ${gallery.pages} pages ready`);
        await testPagination("Hitomi Favorites");
    } finally {
        await restoreLocalStorage(backup);
    }
}

async function runSearch(bundle, url, providerName) {
    await navigate(url);
    const backup = await snapshotLocalStorage();
    try {
        await inject(bundle, url);
        const query = providerName === "hitomi" ? hitomiQuery(url) : imhentaiQuery(url);
        const gallery = await waitForGallery(2);
        assert(gallery.active === "2", `${providerName}: initial page was ${gallery.active}`);
        assert(gallery.rows > 0 && gallery.populatedRows > 0 && gallery.thumbs > 0,
            `${providerName}: gallery rows did not populate`);
        await showPhase(`${providerName}: gallery rendering passed`);
        await testPagination(`${providerName} Search`);
        await testSearchState(query);
        await testBasicModal();
        await testFavoriteToggle();
        await testReaderFlow(bundle, url, providerName);
    } finally {
        await restoreLocalStorage(backup);
    }
}

async function main() {
    await ensureServer();
    await waitForDebugger();
    const contract = await readFile(resolve(root, "test.txt"), "utf8");
    const urls = extractEntryUrls(contract);
    claimedClient = await foregroundClient();
    assertClaimableClient(claimedClient, urls);
    console.log(`Claimed foreground Safari tab at ${claimedClient.href}.`);
    checkAndBuild();
    const bundle = await readFile(resolve(root, "dist/gallery-reader.user.js"), "utf8");
    const allCases = [
        { name: "Hitomi Favorites", run: () => runFavorites(bundle, urls.favorites) },
        { name: "Hitomi Search", run: () => runSearch(bundle, urls.hitomiSearch, "hitomi") },
        { name: "imhentai Search", run: () => runSearch(bundle, urls.imhentaiSearch, "imhentai") },
    ];
    const smoke = process.argv.includes("--smoke");
    const cases = smoke ? allCases.slice(0, 1) : allCases;
    if (smoke) console.log("Smoke mode: running Hitomi Favorites only.");
    const failures = [];
    for (const [index, testCase] of cases.entries()) {
        if (index) await sleep(phasePauseMs);
        process.stdout.write(`[${index + 1}/${cases.length}] ${testCase.name} ... `);
        try {
            await testCase.run();
            console.log("PASS");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ name: testCase.name, message });
            try {
                await showPhase(`${testCase.name} FAILED: ${message}`, "error");
            } catch {
                // Navigation failure may leave no controllable page.
            }
            console.log(`FAIL\n    ${message}`);
        }
    }
    if (failures.length) {
        console.error(`\n${failures.length}/${cases.length} gallery iOS cases failed.`);
        for (const failure of failures) console.error(`- ${failure.name}: ${failure.message}`);
        process.exitCode = 1;
    } else {
        await showPhase("ALL GALLERY TESTS SUCCESSFUL", "success");
        console.log("\nAll gallery iOS cases passed.");
    }
}

try {
    await main();
} catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
} finally {
    await returnToExample();
    if (ownedServer && ownedServer.exitCode === null) ownedServer.kill();
}
