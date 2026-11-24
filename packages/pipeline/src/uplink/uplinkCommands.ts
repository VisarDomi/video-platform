import type { UplinkSetting } from "sdk";
import type { PipelineConfig } from "../config.js";
import { carrierId } from "../upload/providerFactory.js";
import { deployedRunnerCommit, RunnerConnection } from "./runnerConnection.js";

export interface UplinkProbe {
    readonly uplink: string;
    // The network the runner's machine is on, and whether it is the uplink's.
    readonly identity: string;
    readonly onUplink: boolean;
    readonly carrier: {
        readonly present: boolean;
        readonly matches: boolean;
        readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
        readonly freeBytes: number | null;
    };
    readonly browser: string | null;
    readonly platform: string;
    readonly commit: string | null;
}

export function requireUplink(config: Pick<PipelineConfig, "uplink">): UplinkSetting {
    if (!config.uplink) throw new Error("The sites file has no uplink section");
    return config.uplink;
}

// Asks the runner where it is: its network, the carrier and its files, its browser, its commit.
export async function probeUplink(config: Pick<PipelineConfig, "uplink" | "databasePath">, carrierRoot?: string, signal?: AbortSignal): Promise<UplinkProbe> {
    const uplink = requireUplink(config);
    const answer = await RunnerConnection.ask(uplink.runner, await deployedRunnerCommit(config.databasePath), {
        type: "probe", network: uplink.network,
        carrier: { root: carrierRoot ?? uplink.carrier.remoteMount, id: carrierId(uplink) },
    }, "probe", signal);
    const carrier = answer.carrier as UplinkProbe["carrier"];
    return {
        uplink: uplink.id, identity: String(answer.identity), onUplink: answer.onUplink === true,
        carrier: {
            present: carrier?.present === true, matches: carrier?.matches === true,
            files: Array.isArray(carrier?.files) ? carrier.files : [], freeBytes: carrier?.freeBytes ?? null,
        },
        browser: typeof answer.browser === "string" ? answer.browser : null,
        platform: String(answer.platform), commit: typeof answer.commit === "string" ? answer.commit : null,
    };
}

// Unmounts the carrier on the uplink's machine (nothing left to send there).
export async function releaseUplinkCarrier(config: Pick<PipelineConfig, "uplink" | "databasePath">, signal?: AbortSignal): Promise<{ unmounted: boolean; note?: string }> {
    const uplink = requireUplink(config);
    const answer = await RunnerConnection.ask(uplink.runner, await deployedRunnerCommit(config.databasePath), {
        type: "release", carrier: { root: uplink.carrier.remoteMount, id: carrierId(uplink) },
    }, "released", signal);
    return { unmounted: answer.unmounted === true, ...(typeof answer.note === "string" ? { note: answer.note } : {}) };
}
