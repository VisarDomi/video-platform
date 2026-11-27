import assert from "node:assert/strict";
import test from "node:test";
import { DescriptionModelTurns } from "../dist/stages/descriptionModel.js";
import { LaneWakeup } from "../dist/commands/runCampaignWorker.js";

test("the description model's jobs take turns, in order, and a failed one does not stop the next", async () => {
    const model = new DescriptionModelTurns();
    const order = [];
    let release;
    const first = model.take(async () => { order.push("first start"); await new Promise(resolve => { release = resolve; }); order.push("first end"); return 1; });
    const failing = model.take(async () => { order.push("second"); throw new Error("model error"); });
    const third = model.take(async () => { order.push("third"); return 3; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ["first start"], "the second waits for the first");
    release();
    assert.equal(await first, 1);
    await assert.rejects(failing, /model error/);
    assert.equal(await third, 3);
    assert.deepEqual(order, ["first start", "first end", "second", "third"]);
});

test("a lane's wake-up reaches every lane waiting, once", () => {
    const wakeup = new LaneWakeup();
    const woken = [];
    const removeA = wakeup.add(() => woken.push("a"));
    wakeup.add(() => woken.push("b"));
    removeA();
    wakeup.notify();
    assert.deepEqual(woken, ["b"]);
});
