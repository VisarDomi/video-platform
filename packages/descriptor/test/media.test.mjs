import assert from "node:assert/strict";
import test from "node:test";

import { chooseVideoFps } from "../dist/media.js";

const VIDEO_TOKEN_BUDGET = 115_000;
const TOKENS_PER_FRAME = 70.5;
const MAXIMUM_FPS = 4;

test("quality ceilings step down from 4 to 2 to 1 FPS with duration", () => {
    assert.equal(chooseVideoFps(12.35322, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS), 4);
    assert.equal(chooseVideoFps(6 * 60, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS), 4);
    assert.equal(chooseVideoFps(7 * 60, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS), 2);
    assert.equal(chooseVideoFps(13 * 60, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS), 2);
    assert.equal(chooseVideoFps(15 * 60, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS), 1);
});

test("every duration tier reduces FPS when its video-token budget is reached", () => {
    const fourFpsThresholdSeconds = VIDEO_TOKEN_BUDGET / TOKENS_PER_FRAME / 4;
    const twoFpsThresholdSeconds = VIDEO_TOKEN_BUDGET / TOKENS_PER_FRAME / 2;
    const oneFpsThresholdSeconds = VIDEO_TOKEN_BUDGET / TOKENS_PER_FRAME;
    const oneHourFps = chooseVideoFps(3_600, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS);
    const twoHourFps = chooseVideoFps(7_200, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS);

    assert.equal(
        chooseVideoFps(fourFpsThresholdSeconds, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS),
        4,
    );
    assert.ok(chooseVideoFps(7 * 60 - 1, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS) < 4);
    assert.equal(
        chooseVideoFps(twoFpsThresholdSeconds, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS),
        2,
    );
    assert.ok(chooseVideoFps(15 * 60 - 1, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS) < 2);
    assert.equal(
        chooseVideoFps(oneFpsThresholdSeconds, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS),
        1,
    );
    assert.ok(Math.abs(oneHourFps - 0.453) < 0.001);
    assert.ok(Math.abs(twoHourFps - 0.227) < 0.001);
    assert.ok(Math.abs(1 / twoHourFps - 4.413913) < 0.000001);
    assert.ok(Math.abs(twoHourFps * 7_200 * TOKENS_PER_FRAME - VIDEO_TOKEN_BUDGET) < 0.000001);
});

test("FPS selection rejects invalid configuration instead of sending bad model requests", () => {
    assert.throws(
        () => chooseVideoFps(0, VIDEO_TOKEN_BUDGET, TOKENS_PER_FRAME, MAXIMUM_FPS),
        /durationSeconds must be a positive finite number/,
    );
    assert.throws(
        () => chooseVideoFps(60, VIDEO_TOKEN_BUDGET, Number.NaN, MAXIMUM_FPS),
        /tokensPerFrame must be a positive finite number/,
    );
});

test("the upright copy turns a counterclockwise-rotated picture back and keeps its duration", async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { makeUprightCopy } = await import("../dist/media.js");
    const directory = mkdtempSync(path.join(os.tmpdir(), "descriptor-upright-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // Portrait 90x160 with a white top band (the "head"), turned 90° counterclockwise
    // the way the pipeline uploads it: 160x90 with the band on the LEFT edge.
    const rotated = path.join(directory, "rotated.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=90x160:d=3:r=10",
        "-vf", "drawbox=x=0:y=0:w=90:h=20:color=white:t=fill,transpose=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", rotated]);
    const upright = await makeUprightCopy(rotated, directory, 4);
    const probe = (file, entries) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
        "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();
    assert.equal(probe(upright.path, "stream=width,height"), "90,160");
    assert.ok(Math.abs(Number(probe(upright.path, "format=duration")) - 3) < 0.3);
    // The band is back at the top: the first rows are bright, the bottom rows dark.
    const gray = (y) => Number(execFileSync("ffmpeg", ["-v", "error", "-i", upright.path, "-frames:v", "1",
        "-vf", `crop=90:4:0:${y},scale=1:1,format=gray`, "-f", "rawvideo", "-"])[0]);
    assert.ok(gray(4) > 200, `top is ${gray(4)}`);
    assert.ok(gray(150) < 50, `bottom is ${gray(150)}`);
    await upright.remove();
    assert.equal(existsSync(upright.path), false);
});
