#!/usr/bin/env node
import { activateRuntime, runtimeRoot } from "./runtime-common.mjs";

const runtimeId = process.argv[2];
if (!runtimeId) {
    throw new Error(`Usage: node activate-runtime.mjs <runtime-id>\nAvailable runtimes are under ${runtimeRoot}`);
}

const target = await activateRuntime(runtimeId);
console.log(`Activated llama.cpp runtime: ${target}`);
