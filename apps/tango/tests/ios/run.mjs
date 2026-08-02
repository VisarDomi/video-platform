#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    createController,
    createReporter,
    createSession,
    parseSelection,
    runBuildSteps,
    sleep,
} from "userscript-ios-test/controller";

const root = resolve(import.meta.dirname, "../..");
const iosConfig = JSON.parse(
    await readFile(resolve(root, "tests/ios/config.json"), "utf8"),
);
const entryUrl = process.env.IOS_TEST_HOME_URL ?? "https://www.tango.me/";
const legacyTest = process.argv.includes("--actions")
    ? "actions"
    : process.argv.includes("--smoke") ? "smoke" : "full";
const selection = parseSelection(process.argv.slice(2), { defaultTest: legacyTest });
const smoke = selection.test === "smoke";
const actions = selection.test === "actions";
const controller = createController({
    root,
    name: iosConfig.name,
    debuggerName: iosConfig.debuggerName,
    port: iosConfig.port,
    commandTimeoutMs: Number(process.env.IOS_TEST_COMMAND_TIMEOUT_MS ?? 90000),
    connectionTimeoutMs: Number(process.env.IOS_TEST_CONNECTION_TIMEOUT_MS ?? 120000),
});
const session = createSession({
    controller,
    sourceLabel: "stream-viewer.test.user.js",
});
const reporter = createReporter();
const { results, check, skip } = reporter;
let client = null;

async function command(code, expectResult = true) {
    return session.command(code, { expectResult });
}

async function activeClient(predicate) {
    return session.waitForNavigation(predicate, "the expected Safari page");
}

async function navigate(url) {
    client = await session.navigate(url, {
        matches: (candidate, expectedUrl) => {
            const actual = new URL(candidate.href);
            const expected = new URL(expectedUrl);
            return actual.hostname === expected.hostname
                && actual.pathname === expected.pathname
                && actual.search === expected.search;
        },
    });
}

async function inject(bundle) {
    await session.command(`
        window.__streamViewerTest={startedAt:performance.now(),firstRowsAt:null,mutationCount:0};
        const source=${JSON.stringify(bundle)};
        new Function(source+"\\n//# sourceURL=stream-viewer.test.user.js")();
        new MutationObserver(records=>{
            const test=window.__streamViewerTest;
            if(test.firstRowsAt===null&&document.querySelector(".stream-row")) test.firstRowsAt=performance.now();
            test.mutationCount+=records.length;
        }).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
        return source.length;
    `);
}

async function injectFixture(bundle, scenario, path, shared = null) {
    return command(`
        sessionStorage.setItem("stream-viewer-fixture",${JSON.stringify(JSON.stringify(scenario))});
        ${shared
            ? `sessionStorage.setItem("stream-viewer-state",${JSON.stringify(JSON.stringify(shared))});`
            : `sessionStorage.removeItem("stream-viewer-state");`}
        history.replaceState(null,"",${JSON.stringify(path)});
        const source=${JSON.stringify(bundle)};
        new Function(source+"\\n//# sourceURL=stream-viewer.fixture.user.js")();
        return location.href;
    `);
}

function assert(condition, message, details) {
    if (!condition) {
        const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
        throw new Error(`${message}${suffix}`);
    }
}

async function waitForDebugger() {
    client = await session.connect({
        allowedHosts: ["example.com", new URL(entryUrl).hostname],
        controlledCode: `
            return Boolean(
                globalThis.__streamViewerTest ||
                document.querySelector(".stream-list, .stream-stage")
            );
        `,
    });
}

async function homeSnapshot() {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        for(let i=0;i<180&&!document.querySelector(".stream-row")&&!document.querySelector(".status-error");i++) await wait(250);
        const rows=[...document.querySelectorAll(".stream-row")];
        return {
            href:location.href,
            error:document.querySelector(".status-error")?.textContent??null,
            status:document.querySelector(".status")?.textContent??null,
            rowCount:rows.length,
            followed:rows.filter(row=>row.classList.contains("following")).length,
            order:rows.map(row=>row.classList.contains("following")?"followed":"recommended"),
            rows:rows.map(row=>({
                streamerId:row.dataset.streamerId,
                href:row.href,
                text:row.textContent?.trim()??"",
                top:row.getBoundingClientRect().top,
            })),
            scrollHeight:document.documentElement.scrollHeight,
            viewport:innerHeight,
            overflowY:getComputedStyle(document.body).overflowY,
            firstRowsAt:window.__streamViewerTest?.firstRowsAt??null,
        };
    `);
}

async function streamSnapshot() {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        for(let i=0;i<180&&!document.querySelector(".stream-stage")&&!document.querySelector(".status-error");i++) await wait(250);
        for(let i=0;i<120&&(document.querySelectorAll(".stream-slot")[1]?.querySelector("video")?.readyState??0)<2;i++) await wait(250);
        for(let i=0;i<80;i++){
            const shared=JSON.parse(sessionStorage.getItem("stream-viewer-state")??"null");
            const index=shared?.streams?.findIndex(stream=>stream.streamerId===shared.currentStreamerId)??-1;
            const logical=["previous","current","next"]
                .map(role=>document.querySelector(".stream-slot."+role+"-scope"));
            const expected=shared&&index>=0?[-1,0,1].map(offset=>shared.streams[index+offset]?.masterListUrl??""):[];
            if(expected.length===3&&logical.every((slot,position)=>(slot?.querySelector("video")?.getAttribute("src")??"")===expected[position])) break;
            await wait(100);
        }
        const domSlots=[...document.querySelectorAll(".stream-slot")];
        const slots=["previous","current","next"]
            .map(role=>document.querySelector(".stream-slot."+role+"-scope"));
        const current=slots[1];
        const video=current?.querySelector("video");
        const shared=JSON.parse(sessionStorage.getItem("stream-viewer-state")??"null");
        const index=shared?.streams?.findIndex(stream=>stream.streamerId===shared.currentStreamerId)??-1;
        return {
            href:location.href,
            error:document.querySelector(".status-error")?.textContent??null,
            status:document.querySelector(".status")?.textContent??null,
            slotCount:domSlots.length,
            slots:slots.map(slot=>({
                hidden:slot?.querySelector("video")?.hidden??true,
                src:slot?.querySelector("video")?.getAttribute("src")??"",
                readyState:slot?.querySelector("video")?.readyState??0,
            })),
            currentId:shared?.currentStreamerId??null,
            expected:shared&&index>=0?[-1,0,1].map(offset=>shared.streams[index+offset]?.masterListUrl??null):[],
            streamCount:shared?.streams?.length??0,
            streamIds:shared?.streams?.map(stream=>stream.streamerId)??[],
            name:document.querySelector(".stream-controls .stream-name")?.textContent?.trim()??"",
            muted:video?.muted??null,
            muteText:document.querySelector(".stream-controls .mute")?.textContent??"",
            followText:document.querySelector(".stream-controls .follow")?.textContent??"",
            downloadText:document.querySelector(".stream-controls .download")?.textContent??"",
            readyState:video?.readyState??0,
            historyLength:history.length,
        };
    `);
}

async function drag({ fromX, fromY, toX, toY, identifier }) {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        const target=document.querySelector(".stream-stage");
        const touch=(x,y)=>new Touch({identifier:${identifier},target,clientX:x,clientY:y});
        target.dispatchEvent(new TouchEvent("touchstart",{touches:[touch(${fromX},${fromY})],changedTouches:[touch(${fromX},${fromY})],bubbles:true,cancelable:true}));
        target.dispatchEvent(new TouchEvent("touchmove",{touches:[touch(${toX},${toY})],changedTouches:[touch(${toX},${toY})],bubbles:true,cancelable:true}));
        if(Math.abs(${toY}-${fromY})>Math.abs(${toX}-${fromX})) window.scrollBy(0,${fromY}-${toY});
        target.dispatchEvent(new TouchEvent("touchend",{touches:[],changedTouches:[touch(${toX},${toY})],bubbles:true,cancelable:true}));
        await wait(400);
        return {
            href:location.href,
            historyLength:history.length,
            controlsHidden:document.querySelector(".stream-controls")?.classList.contains("hidden")??null,
            navigating:document.querySelector(".stream-stage")?.classList.contains("viewer-navigating")??false,
            roles:[...document.querySelectorAll(".stream-slot")].map(slot=>
                ["previous","current","next"].find(role=>slot.classList.contains(role+"-scope"))??null),
        };
    `);
}

function fixtureStream(id, { following = false, parentStreamerId, name = id } = {}) {
    return {
        streamerId: `account-${id}`,
        streamId: id,
        masterListUrl: `https://media.w3.org/2010/05/sintel/trailer.mp4#${id}`,
        firstName: name,
        isFollowing: following,
        ...(parentStreamerId ? { parentStreamerId } : {}),
    };
}

async function fixtureState(expectedCurrentId = null, { afterRefreshFrom = null } = {}) {
    return command(`
        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
        for(let attempt=0;attempt<100;attempt++){
            const shared=JSON.parse(sessionStorage.getItem("stream-viewer-state")??"null");
            const fixture=JSON.parse(sessionStorage.getItem("stream-viewer-fixture")??"null");
            const expected=${JSON.stringify(expectedCurrentId)};
            const previous=${JSON.stringify(afterRefreshFrom)};
            const refreshed=previous===null||(fixture?.fetchCount>0&&shared?.currentStreamerId!==previous);
            if(shared?.streams?.length&&refreshed&&(expected===null||shared.currentStreamerId===expected)){
                await wait(100);
                const logical=["previous","current","next"]
                    .map(role=>document.querySelector(".stream-slot."+role+"-scope"));
                return {
                    href:location.href,
                    currentId:shared.currentStreamerId,
                    streams:shared.streams,
                    ids:shared.streams.map(stream=>stream.streamerId),
                    names:shared.streams.map(stream=>stream.alias||stream.firstName),
                    slots:logical.map(slot=>slot?.querySelector("video")?.getAttribute("src")??""),
                    visibleName:document.querySelector(".stream-controls .stream-name")?.textContent?.trim()??"",
                    fixture,
                    error:document.querySelector(".status-error")?.textContent??null,
                };
            }
            await wait(100);
        }
        return {
            error:document.querySelector(".status-error")?.textContent??"Fixture state timed out",
            fixture:JSON.parse(sessionStorage.getItem("stream-viewer-fixture")??"null"),
        };
    `);
}

async function runLiveActions() {
    await check(["A1"], "Follow control changes visible state and restores it before destructive checks", async () => {
        const outcome = await command(`
            const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const button=document.querySelector(".stream-controls .follow");
            const before=button.textContent;
            button.click();
            for(let i=0;i<80&&button.textContent===before;i++) await wait(100);
            const changed=button.textContent;
            button.click();
            for(let i=0;i<80&&button.textContent!==before;i++) await wait(100);
            return {before,changed,restored:button.textContent};
        `);
        assert(outcome.changed !== outcome.before, "Follow state did not visibly change", outcome);
        assert(outcome.restored === outcome.before, "Follow state was not restored", outcome);
        return outcome;
    });

    await check(["A5"], "Download-list control changes visible membership and restores it", async () => {
        const outcome = await command(`
            const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const button=document.querySelector(".stream-controls .download");
            await wait(500);
            const before=button.textContent;
            button.click();
            for(let i=0;i<80&&button.textContent===before;i++) await wait(100);
            const changed=button.textContent;
            button.click();
            for(let i=0;i<80&&button.textContent!==before;i++) await wait(100);
            return {before,changed,restored:button.textContent};
        `);
        assert(outcome.changed !== outcome.before, "Download-list state did not visibly change", outcome);
        assert(outcome.restored === outcome.before, "Download-list state was not restored", outcome);
        return outcome;
    });
}

async function main() {
    if (selection.args.some(argument => !["--smoke", "--actions"].includes(argument))) {
        throw new Error(`Unknown test arguments: ${selection.args.join(" ")}`);
    }
    if (!["full", "smoke", "actions"].includes(selection.test)) {
        throw new Error(`Unknown test "${selection.test}". Expected full, smoke, or actions.`);
    }
    if (selection.site && selection.site !== "tango") {
        throw new Error(`Unknown site "${selection.site}". Expected tango.`);
    }

    await waitForDebugger();
    runBuildSteps(controller, [
        ["npx", ["tsc", "--noEmit"]],
        ["npx", ["vite", "build"]],
        ["npx", ["vite", "build", "--config", "vite.fixture.config.ts"]],
    ]);
    const bundle = await readFile(resolve(root, "dist/stream-viewer.user.js"), "utf8");
    const fixtureBundle = await readFile(resolve(root, "dist/stream-viewer-fixture.js"), "utf8");

    await navigate(entryUrl);
        await inject(bundle);
        const homeClientId = client.client;

        const home = await check(["H1", "H2", "H3", "H4"], "Home renders the live followed + recommended list promptly", async () => {
            const snapshot = await homeSnapshot();
            assert(!snapshot.error, snapshot.error, snapshot);
            assert(snapshot.rowCount > 1, "Home did not render more than one live stream", snapshot);
            assert(snapshot.followed > 0, "Home has no followed streams", {
                rowCount: snapshot.rowCount,
                followed: snapshot.followed,
            });
            assert(snapshot.followed < snapshot.rowCount, "Home has no recommended streams", {
                rowCount: snapshot.rowCount,
                followed: snapshot.followed,
            });
            const firstRecommended = snapshot.order.indexOf("recommended");
            assert(!snapshot.order.slice(firstRecommended).includes("followed"), "Followed streams are not before recommended streams", {
                order: snapshot.order,
            });
            assert(snapshot.firstRowsAt !== null, "The stream list never became observable", {
                firstRowsAt: snapshot.firstRowsAt,
                rowCount: snapshot.rowCount,
            });
            assert(snapshot.overflowY !== "hidden", "Home disables document scrolling", {
                overflowY: snapshot.overflowY,
            });
            return snapshot;
        });

        const selectedIndex = Math.min(2, home.rows.length - 1);
        let selected;
        await check(["H5"], "Selecting a Home row navigates to that stream URL", async () => {
            selected = await command(`
                const row=document.querySelectorAll(".stream-row")[${selectedIndex}];
                row.scrollIntoView({block:"center"});
                await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                const value={
                    streamerId:row.dataset.streamerId,
                    href:row.href,
                    text:row.textContent?.trim()??"",
                    top:row.getBoundingClientRect().top,
                };
                row.click();
                return value;
            `);
            client = await activeClient(candidate => new URL(candidate.href).pathname.startsWith("/stream/"));
            assert(client.href === selected.href, `Selected ${selected.href}, reached ${client.href}`);
            return { selected };
        });

        await inject(bundle);
        const initial = await check(["S1", "S2", "S3", "S4", "U1", "U4"], "Stream route starts playback with correct adjacent streams and UI", async () => {
            const snapshot = await streamSnapshot();
            assert(!snapshot.error, snapshot.error, snapshot);
            assert(snapshot.slotCount === 3, "Stream does not have three navigation slots", snapshot);
            assert(snapshot.slots[1].src === snapshot.expected[1], "Current slot does not match persisted stream order", snapshot);
            for (const position of [0, 2]) {
                if (snapshot.expected[position]) {
                    assert(snapshot.slots[position].src === snapshot.expected[position], `Adjacent slot ${position} is incorrect`, snapshot);
                }
            }
            assert(snapshot.readyState >= 2, "Current stream media did not become playable", snapshot);
            assert(snapshot.muted === true && snapshot.muteText.includes("🔇"), "New stream is not visibly muted", snapshot);
            assert(snapshot.name.length > 0, "Current stream has no visible name", snapshot);
            return snapshot;
        });

        await check(["U2"], "Mute control changes playback audio and visible state", async () => {
            const outcome = await command(`
                const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                const current=document.querySelector(".stream-slot.current-scope");
                const video=current.querySelector("video");
                const button=document.querySelector(".stream-controls .mute");
                const before={muted:video.muted,text:button.textContent};
                button.click(); await wait(150);
                const changed={muted:video.muted,text:button.textContent};
                button.click(); await wait(150);
                return {before,changed,restored:{muted:video.muted,text:button.textContent}};
            `);
            assert(outcome.changed.muted !== outcome.before.muted, "Mute button did not change video.muted", outcome);
            assert(outcome.changed.text !== outcome.before.text, "Mute button did not change its visible state", outcome);
            assert(outcome.restored.muted === outcome.before.muted, "Mute state was not restored", outcome);
            return outcome;
        });

        await check(["A2"], "Block requires a second confirmation", async () => {
            const outcome = await command(`
                const button=document.querySelector(".stream-controls .block");
                const before={confirm:button.dataset.confirm,text:button.textContent};
                button.click();
                return {before,after:{confirm:button.dataset.confirm,text:button.textContent}};
            `);
            assert(outcome.before.confirm !== "true", "Block started in confirmed state", outcome);
            assert(outcome.after.confirm === "true", "First Block press did not arm confirmation", outcome);
            assert(outcome.after.text !== outcome.before.text, "Block confirmation has no visible state", outcome);
            return outcome;
        });

        if (actions && !smoke) await runLiveActions();

        if (smoke) {
            skip(["N1", "N2", "N3", "N4", "B1", "B2", "B3"], "Navigation and Back restoration", "smoke mode");
        } else {
            await check(["N2"], "A short vertical drag returns to the current stream", async () => {
                const before = await streamSnapshot();
                const after = await drag({ fromX: 200, fromY: 500, toX: 200, toY: 450, identifier: 1 });
                assert(after.href === before.href, "Short drag changed the stream URL", { before, after });
                assert(after.navigating === false, "Viewer did not return to its resting state", after);
                assert(after.roles.join("|") === "previous|current|next", "Logical slot roles changed after a short drag", after);
                return { before: before.href, after };
            });

            await check(["N1"], "A vertical drag visibly reveals the adjacent stream before release", async () => {
                const outcome = await command(`
                    const target=document.querySelector(".stream-stage");
                    const touch=(y)=>new Touch({identifier:10,target,clientX:200,clientY:y});
                    target.dispatchEvent(new TouchEvent("touchstart",{touches:[touch(600)],changedTouches:[touch(600)],bubbles:true,cancelable:true}));
                    target.dispatchEvent(new TouchEvent("touchmove",{touches:[touch(350)],changedTouches:[touch(350)],bubbles:true,cancelable:true}));
                    const stage=document.querySelector(".stream-stage");
                    const previous=document.querySelector(".stream-slot.previous-scope");
                    const next=document.querySelector(".stream-slot.next-scope");
                    const during={
                        navigating:stage.classList.contains("viewer-navigating"),
                        previous:getComputedStyle(previous).justifyContent,
                        next:getComputedStyle(next).justifyContent,
                    };
                    target.dispatchEvent(new TouchEvent("touchcancel",{touches:[],changedTouches:[touch(350)],bubbles:true,cancelable:true}));
                    window.dispatchEvent(new Event("scrollend"));
                    await new Promise(resolve=>setTimeout(resolve,300));
                    const after={
                        navigating:stage.classList.contains("viewer-navigating"),
                        previous:getComputedStyle(previous).justifyContent,
                        next:getComputedStyle(next).justifyContent,
                    };
                    return {during,after};
                `);
                assert(outcome.during.navigating && outcome.during.previous === "flex-end" && outcome.during.next === "flex-start", "Vertical intent did not bring adjacent streams beside the current stream", outcome);
                assert(!outcome.after.navigating && outcome.after.previous === "flex-start" && outcome.after.next === "flex-end", "Settled viewer did not park adjacent streams", outcome);
                return outcome;
            });

            await check(["U3"], "Horizontal gestures hide and show stream controls", async () => {
                const hidden = await drag({ fromX: 300, fromY: 500, toX: 150, toY: 500, identifier: 2 });
                const shown = await drag({ fromX: 100, fromY: 500, toX: 250, toY: 500, identifier: 3 });
                assert(hidden.controlsHidden === true, "Left gesture did not hide controls", { hidden, shown });
                assert(shown.controlsHidden === false, "Right gesture did not show controls", { hidden, shown });
                return { hidden, shown };
            });

            const moved = await check(["N1", "N3", "N4"], "A full vertical drag moves to the correct adjacent stream without adding history", async () => {
                const before = await streamSnapshot();
                assert(before.expected[2], "No next stream is available for navigation", before);
                const afterDrag = await drag({ fromX: 200, fromY: 700, toX: 200, toY: 120, identifier: 4 });
                const after = await streamSnapshot();
                assert(after.href !== before.href, "Full vertical drag did not change stream URL", { before, afterDrag, after });
                assert(after.historyLength === before.historyLength, "Vertical navigation added a Back step", { before, after });
                assert(after.slots[1].src === before.expected[2], "Vertical navigation selected the wrong adjacent stream", { before, after });
                assert(after.slots[0].src === after.expected[0] && after.slots[2].src === (after.expected[2] ?? ""), "Adjacent slots are wrong after navigation", after);
                return { before, after };
            });

            await check(["S5"], "Refreshing a stream URL re-fetches and retains the requested stream when available", async () => {
                const streamUrl = moved.after.href;
                await navigate(streamUrl);
                await inject(bundle);
                const refreshed = await streamSnapshot();
                assert(!refreshed.error, refreshed.error, refreshed);
                const stillAvailable = refreshed.streamIds.includes(moved.after.currentId);
                if (stillAvailable) {
                    assert(refreshed.currentId === moved.after.currentId, "Refresh did not retain the available requested streamer", {
                        requestedId: moved.after.currentId,
                        currentId: refreshed.currentId,
                    });
                } else {
                    assert(refreshed.currentId !== moved.after.currentId, "Refresh retained a streamer absent from the fresh list", {
                        requestedId: moved.after.currentId,
                        currentId: refreshed.currentId,
                    });
                }
                return { ...refreshed, requestedUrl: streamUrl, requestedStillAvailable: stillAvailable };
            });

            if (actions) {
                await check(["A3", "A4"], "Confirmed block unfollows when needed and removes the streamer", async () => {
                    const before = await streamSnapshot();
                    const outcome = await command(`
                        const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                        const follow=document.querySelector(".stream-controls .follow");
                        if(follow.textContent!=="❤️"){
                            follow.click();
                            for(let i=0;i<80&&follow.textContent!=="❤️";i++) await wait(100);
                        }
                        const block=document.querySelector(".stream-controls .block");
                        block.click();
                        const armed=block.dataset.confirm==="true";
                        block.click();
                        for(let i=0;i<120;i++){
                            const shared=JSON.parse(sessionStorage.getItem("stream-viewer-state")??"null");
                            if(shared?.currentStreamerId!==${JSON.stringify(before.currentId)}){
                                return {
                                    armed,
                                    oldId:${JSON.stringify(before.currentId)},
                                    currentId:shared.currentStreamerId,
                                    oldPresent:shared.streams.some(stream=>stream.streamerId===${JSON.stringify(before.currentId)}),
                                };
                            }
                            await wait(100);
                        }
                        return {armed,timedOut:true};
                    `);
                    assert(outcome.armed, "Destructive Block was not confirmed in two steps", outcome);
                    assert(!outcome.timedOut && !outcome.oldPresent, "Blocked streamer was not removed", outcome);
                    return outcome;
                });
            }

            await check(["B1", "B2"], "Back restores the updated Home list and highlight", async () => {
                const beforeBack = await streamSnapshot();
                await command("history.back(); return true;", false);
                client = await activeClient(candidate => {
                    const url = new URL(candidate.href);
                    return url.hostname === new URL(entryUrl).hostname
                        && url.pathname === new URL(entryUrl).pathname;
                });
                const restoration = client.client === homeClientId ? "bfcache" : "reload";
                if (restoration === "reload") await inject(bundle);
                const restored = await homeSnapshot();
                const alignment = await command(`
                    const current=document.querySelector(".stream-row.current");
                    return {
                        exists:Boolean(current),
                        streamerId:current?.dataset.streamerId??null,
                        top:current?.getBoundingClientRect().top??null,
                    };
                `);
                assert(alignment.exists, "Back did not highlight the last viewed streamer", { restored, alignment });
                const originalIds = new Set(home.rows.map(row => row.streamerId));
                const discoveredIds = beforeBack.streamIds.filter(streamerId => !originalIds.has(streamerId));
                const restoredIds = new Set(restored.rows.map(row => row.streamerId));
                const missingDiscoveredIds = discoveredIds.filter(streamerId => !restoredIds.has(streamerId));
                assert(missingDiscoveredIds.length === 0, "Back lost streams discovered while viewing streams", {
                    restoration,
                    discoveredIds,
                    restoredCount: restored.rowCount,
                    missingDiscoveredIds,
                });
                assert(alignment.streamerId === beforeBack.currentId, "Back highlighted the wrong streamer", {
                    expected: beforeBack.currentId,
                    actual: alignment.streamerId,
                });
                return { restoration, restoredCount: restored.rowCount, discoveredCount: discoveredIds.length, alignment };
            }, { continueOnFailure: true });

            await navigate("https://example.com/");

            await check(["H3", "H4"], "Fixture Home renders before delayed enrichment and refreshes from the provider", async () => {
                const first = [
                    fixtureStream("home-a", { following: true, name: "Raw A" }),
                    fixtureStream("home-b", { name: "Raw B" }),
                ];
                const second = [
                    fixtureStream("home-c", { following: true, name: "Fresh C" }),
                    fixtureStream("home-d", { name: "Fresh D" }),
                ];
                const scenario = {
                    fetches: [first, second],
                    enrichDelay: 2500,
                    enriched: {
                        "account-home-a": { alias: "alias-a", firstName: "Enriched A" },
                        "account-home-b": { alias: "alias-b", firstName: "Enriched B" },
                    },
                };
                await injectFixture(fixtureBundle, scenario, "/fixture/home");
                const early = await command(`
                    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                    for(let i=0;i<40&&!document.querySelector(".stream-row");i++) await wait(25);
                    return [...document.querySelectorAll(".stream-row")].map(row=>row.textContent.trim());
                `);
                assert(early.some(name => name.includes("Raw A")), "Home waited for enrichment before rendering", early);
                await sleep(2700);
                const enriched = await command(`return [...document.querySelectorAll(".stream-row")].map(row=>row.textContent.trim())`);
                assert(enriched.some(name => name.includes("alias-a") && name.includes("Enriched A")), "Home names did not improve after rendering", enriched);
                await injectFixture(fixtureBundle, JSON.parse(await command(`return sessionStorage.getItem("stream-viewer-fixture")`)), "/fixture/home");
                const refreshed = await command(`
                    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                    for(let i=0;i<60&&!document.querySelector('[data-streamer-id="account-home-c"]');i++) await wait(25);
                    return [...document.querySelectorAll(".stream-row")].map(row=>row.dataset.streamerId);
                `);
                assert(refreshed.includes("account-home-c") && !refreshed.includes("account-home-a"), "Home refresh did not use a fresh provider list", refreshed);
                return { early, enriched, refreshed };
            }, { continueOnFailure: true });

            await check(["B2"], "Fixture Home highlights the last viewed streamer without forcing a scroll", async () => {
                const first = fixtureStream("highlight-first");
                const viewed = fixtureStream("highlight-viewed");
                const scenario = { fetches: [[first, viewed]] };
                const shared = { streams: [first, viewed], currentStreamerId: viewed.streamerId, selectedTop: 200 };
                await injectFixture(fixtureBundle, scenario, "/fixture/home", shared);
                const outcome = await command(`
                    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                    for(let i=0;i<40&&!document.querySelector(".stream-row.current");i++) await wait(25);
                    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                    const current=document.querySelector(".stream-row.current");
                    const fixture=JSON.parse(sessionStorage.getItem("stream-viewer-fixture")??"null");
                    return {
                        currentId:current?.dataset.streamerId??null,
                        scrollRequests:fixture?.scrollRequests??[],
                    };
                `);
                assert(outcome.currentId === viewed.streamerId, "Home did not highlight the last viewed streamer", outcome);
                assert(outcome.scrollRequests.length === 0, "Home forced a scroll while restoring the highlight", outcome);
                return outcome;
            }, { continueOnFailure: true });

            await check(["S3", "N5"], "Fixture stream starts before delayed enrichment and inserts costreamers in order", async () => {
                const previous = fixtureStream("previous");
                const parent = fixtureStream("parent", { name: "Raw Parent" });
                const next = fixtureStream("next");
                const coOne = fixtureStream("co-one", { parentStreamerId: parent.streamerId });
                const coTwo = fixtureStream("co-two", { parentStreamerId: parent.streamerId });
                const scenario = {
                    fetches: [[previous, parent, next]],
                    costreamers: { [parent.streamerId]: [coOne, coTwo] },
                    enrichDelay: 2500,
                    enriched: { [parent.streamerId]: { alias: "best-parent", firstName: "Enriched Parent" } },
                };
                await injectFixture(fixtureBundle, scenario, `/fixture/stream/${parent.streamId}`);
                const early = await command(`
                    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                    for(let i=0;i<40&&!document.querySelector(".stream-stage");i++) await wait(25);
                    const current=document.querySelector(".stream-slot.current-scope");
                    return {
                        visibleName:document.querySelector(".stream-controls .stream-name")?.textContent?.trim()??"",
                        src:current?.querySelector("video")?.getAttribute("src")??"",
                        status:document.querySelector(".status")?.textContent??null,
                        slots:[...document.querySelectorAll(".stream-slot")].map(slot=>({
                            role:["previous","current","next"].find(role=>slot.classList.contains(role+"-scope"))??null,
                            hidden:slot.querySelector("video")?.hidden??true,
                            src:slot.querySelector("video")?.getAttribute("src")??"",
                        })),
                        fixture:JSON.parse(sessionStorage.getItem("stream-viewer-fixture")??"null"),
                    };
                `);
                assert(early.visibleName.includes("Raw Parent"), "Stream waited for enrichment before showing its UI", early);
                assert(early.src === parent.masterListUrl, "Stream playback source waited for enrichment", early);
                await sleep(2700);
                const settled = await fixtureState(parent.streamerId);
                assert(settled.ids.join("|") === [
                    previous.streamerId,
                    parent.streamerId,
                    coOne.streamerId,
                    coTwo.streamerId,
                    next.streamerId,
                ].join("|"), "Costreamers were inserted at the wrong position", settled);
                assert(settled.slots[2] === coOne.masterListUrl, "First discovered costreamer did not become next", settled);
                assert(settled.visibleName.includes("best-parent") && settled.visibleName.includes("Enriched Parent"), "Best streamer name did not appear after enrichment", settled);
                return { earlyName: early.visibleName, settled };
            }, { continueOnFailure: true });

            await check(["S6"], "Fixture refresh ignores stale costreamers and falls back to the first fresh stream", async () => {
                const missing = fixtureStream("missing");
                const oldNext = fixtureStream("old-next");
                const staleCostreamer = fixtureStream("stale-costreamer", { parentStreamerId: missing.streamerId });
                const freshFirst = fixtureStream("fresh-first-with-stale-co");
                const freshSecond = fixtureStream("fresh-second-with-stale-co");
                const scenario = {
                    fetches: [[freshFirst, freshSecond]],
                    fetchDelay: 250,
                    costreamers: { [missing.streamerId]: [staleCostreamer] },
                };
                const shared = { streams: [missing, oldNext], currentStreamerId: missing.streamerId, selectedTop: 200 };
                await injectFixture(fixtureBundle, scenario, `/fixture/stream/${missing.streamId}`, shared);
                const settled = await fixtureState(null, { afterRefreshFrom: missing.streamerId });
                assert(!settled.error, settled.error, settled);
                assert(settled.currentId === freshFirst.streamerId, "Missing current stream did not fall back to the first fresh stream", settled);
                assert(!settled.ids.includes(staleCostreamer.streamerId), "A stale costreamer was inserted for the unavailable stream", settled);
                assert(!(settled.fixture.costreamerRequests ?? []).includes(missing.streamerId), "Unavailable stream was queried for stale costreamers", settled);
                return settled;
            }, { continueOnFailure: true });

            await check(["S7"], "Fixture refresh falls back to the first fresh stream without a costreamer", async () => {
                const missing = fixtureStream("missing-no-co");
                const freshFirst = fixtureStream("fresh-first");
                const freshSecond = fixtureStream("fresh-second");
                const scenario = { fetches: [[freshFirst, freshSecond]], fetchDelay: 250, costreamers: {} };
                const shared = { streams: [missing], currentStreamerId: missing.streamerId, selectedTop: 200 };
                await injectFixture(fixtureBundle, scenario, `/fixture/stream/${missing.streamId}`, shared);
                const settled = await fixtureState(freshFirst.streamerId);
                assert(!settled.error, settled.error, settled);
                assert(settled.currentId === freshFirst.streamerId, "Missing current stream did not fall back to the first fresh stream", settled);
                return settled;
            }, { continueOnFailure: true });

            await check(["U5"], "Fixture removes an audio-only current stream", async () => {
                const before = fixtureStream("video-before");
                const audio = fixtureStream("audio");
                const after = fixtureStream("video-after");
                await injectFixture(fixtureBundle, { fetches: [[before, audio, after]] }, `/fixture/stream/${audio.streamId}`);
                await fixtureState(audio.streamerId);
                const outcome = await command(`
                    const current=document.querySelector(".stream-slot.current-scope");
                    const video=current.querySelector("video");
                    Object.defineProperties(video,{
                        videoWidth:{configurable:true,get:()=>0},
                        videoHeight:{configurable:true,get:()=>0},
                    });
                    const event=new Event("playing");
                    event.fixtureTriggered=true;
                    video.dispatchEvent(event);
                    return true;
                `);
                assert(outcome, "Could not trigger the audio-only fixture");
                const settled = await fixtureState(after.streamerId);
                assert(!settled.ids.includes(audio.streamerId), "Audio-only stream remained available", settled);
                return settled;
            }, { continueOnFailure: true });

            await check(["A6"], "Fixture removes a current stream whose media becomes unavailable", async () => {
                const before = fixtureStream("available-before");
                const unavailable = fixtureStream("unavailable");
                const after = fixtureStream("available-after");
                await injectFixture(fixtureBundle, { fetches: [[before, unavailable, after]] }, `/fixture/stream/${unavailable.streamId}`);
                await fixtureState(unavailable.streamerId);
                await command(`
                    const current=document.querySelector(".stream-slot.current-scope");
                    const event=new Event("error");
                    event.fixtureTriggered=true;
                    current.querySelector("video").dispatchEvent(event);
                    return true;
                `);
                const settled = await fixtureState(after.streamerId);
                assert(!settled.ids.includes(unavailable.streamerId), "Unavailable stream remained in navigation", settled);
                return settled;
            }, { continueOnFailure: true });
        }

    if (!actions) {
        skip(["A1", "A5"], "Reversible follow and download-list actions", "pass --actions to permit external account mutations");
        skip(["A3", "A4"], "Successful block unfollows and removes the streamer", "pass --actions to permit a destructive real-account block");
    }

    const failed = results.filter(result => result.status === "FAIL");
    const passed = results.filter(result => result.status === "PASS");
    const skipped = results.filter(result => result.status === "SKIP");
    console.log(`\nResult: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped.`);
    if (failed.length) process.exitCode = 1;
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    try {
        if (session.client && new URL(session.client.href).hostname === "example.com") {
            await session.reload("https://example.com/", {
                before: `
                    sessionStorage.removeItem("stream-viewer-fixture");
                    sessionStorage.removeItem("stream-viewer-state");
                `,
            });
        } else {
            await session.cleanup();
        }
    } catch (error) {
        console.error("Example.com cleanup failed:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
    session.close();
}
