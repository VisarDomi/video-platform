// ---- Uplink ---------------------------------------------------------------------------
//
// A second network uploads can leave from. The PC that keeps the ledger always uploads
// from its own network ("home"); a deployment may add one more, reached through a carrier
// drive that takes converted files there and a runner on that network's machine that
// performs one upload at a time when the PC tells it to. The ledger stays on the PC.
//
//   { "uplink": { "id": "office", "dailyBytes": 50000000000,
//                 "network": { "gateway": "aa:bb:cc:dd:ee:ff" },
//                 "carrier": { "label": "CARRIER1", "capacityBytes": 230000000000,
//                              "remoteMount": "/Volumes/CARRIER1" },
//                 "runner": ["ssh", "host", "node", "/path/to/uplinkRunner.js"] },
//     "sites": [ ... ] }
//
// "network.gateway" is the uplink's identity: the hardware address of its default gateway
// (addresses and private ranges repeat between networks; that does not). "network.probe" is
// a command whose output is the identity instead, for tests and simulations. "carrier"
// names a removable drive by its filesystem label, or a plain directory by "path" (tests);
// "remoteMount" is where the runner finds it on the uplink's machine (default: "path").
// "runner" is the command that starts the runner; it speaks JSON lines on stdin/stdout.
// "minFreeBytes" is the free space the PC keeps on its artifacts filesystem when it
// converts ahead (default 100 GB).

export interface UplinkSetting {
    readonly id: string;
    readonly dailyBytes: number;
    readonly network: { readonly gateway: string; readonly probe?: readonly string[] };
    readonly carrier: {
        readonly label?: string;
        readonly path?: string;
        readonly capacityBytes: number;
        readonly remoteMount: string;
    };
    readonly runner: readonly string[];
    readonly minFreeBytes: number;
}

export const HOME_UPLINK_ID = "home";
export const DEFAULT_UPLINK_MIN_FREE_BYTES = 100_000_000_000;
const UPLINK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CARRIER_LABEL = /^[A-Za-z0-9_-]{1,11}$/;

function commandList(value: unknown, where: string): string[] {
    if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string" && part.length > 0)) {
        throw new Error(`${where} must be a non-empty list of non-empty strings`);
    }
    return [...value];
}

function positiveInteger(value: unknown, where: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${where} must be a positive integer`);
    return value as number;
}

function object(value: unknown, where: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
    return value as Record<string, unknown>;
}

// The sites file's "uplink" section, or null when it has none (no second uplink).
export function parseUplink(text: string, source = "sites file"): UplinkSetting | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error: any) {
        throw new Error(`${source}: invalid JSON (${error.message})`);
    }
    const raw = (parsed as { uplink?: unknown } | null)?.uplink;
    if (raw === undefined) return null;
    const where = `${source}: uplink`;
    const entry = object(raw, where);
    const known = new Set(["id", "dailyBytes", "network", "carrier", "runner", "minFreeBytes"]);
    for (const key of Object.keys(entry)) if (!known.has(key)) throw new Error(`${where}: unknown key ${key}`);
    if (typeof entry.id !== "string" || !UPLINK_ID.test(entry.id)) throw new Error(`${where}: invalid id ${JSON.stringify(entry.id)}`);
    if (entry.id === HOME_UPLINK_ID) throw new Error(`${where}: id "home" is the PC's own network`);
    const dailyBytes = positiveInteger(entry.dailyBytes, `${where}: dailyBytes`);
    const network = object(entry.network, `${where}: network`);
    if (typeof network.gateway !== "string" || !network.gateway.trim()) throw new Error(`${where}: network: gateway is required`);
    const probe = network.probe === undefined ? undefined : commandList(network.probe, `${where}: network: probe`);
    const carrier = object(entry.carrier, `${where}: carrier`);
    const hasLabel = carrier.label !== undefined;
    const hasPath = carrier.path !== undefined;
    if (hasLabel === hasPath) throw new Error(`${where}: carrier: give either label or path`);
    if (hasLabel && (typeof carrier.label !== "string" || !CARRIER_LABEL.test(carrier.label))) {
        throw new Error(`${where}: carrier: label must be 1-11 letters, digits, "-" or "_"`);
    }
    if (hasPath && (typeof carrier.path !== "string" || !carrier.path.startsWith("/"))) {
        throw new Error(`${where}: carrier: path must be absolute`);
    }
    const capacityBytes = positiveInteger(carrier.capacityBytes, `${where}: carrier: capacityBytes`);
    const remoteMount = carrier.remoteMount ?? carrier.path;
    if (typeof remoteMount !== "string" || !remoteMount.startsWith("/")) {
        throw new Error(`${where}: carrier: remoteMount must be an absolute path`);
    }
    const runner = commandList(entry.runner, `${where}: runner`);
    const minFreeBytes = entry.minFreeBytes === undefined ? DEFAULT_UPLINK_MIN_FREE_BYTES
        : positiveInteger(entry.minFreeBytes, `${where}: minFreeBytes`);
    return {
        id: entry.id,
        dailyBytes,
        network: { gateway: network.gateway.trim().toLowerCase(), ...(probe ? { probe } : {}) },
        carrier: {
            ...(hasLabel ? { label: carrier.label as string } : { path: carrier.path as string }),
            capacityBytes,
            remoteMount,
        },
        runner,
        minFreeBytes,
    };
}
