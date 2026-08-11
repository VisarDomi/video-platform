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
