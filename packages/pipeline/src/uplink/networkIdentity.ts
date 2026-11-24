import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAC_ADDRESS = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

// Octets without leading zeros (macOS prints "4c:6:17:...") become two digits each.
export function normalizeHardwareAddress(text: string): string | null {
    const parts = text.trim().toLowerCase().split(/[:-]/);
    if (parts.length !== 6 || !parts.every((part) => /^[0-9a-f]{1,2}$/.test(part))) return null;
    const address = parts.map((part) => part.padStart(2, "0")).join(":");
    return MAC_ADDRESS.test(address) && address !== "00:00:00:00:00:00" && address !== "ff:ff:ff:ff:ff:ff" ? address : null;
}

async function output(command: string, args: readonly string[]): Promise<string> {
    const { stdout } = await run(command, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return stdout;
}

// The default route's gateway and interface.
export function parseDefaultRoute(platform: NodeJS.Platform, text: string): { gateway: string; device: string } | null {
    if (platform === "darwin") {
        const gateway = text.match(/^\s*gateway:\s*(\S+)/m)?.[1];
        const device = text.match(/^\s*interface:\s*(\S+)/m)?.[1];
        return gateway && device ? { gateway, device } : null;
    }
    const line = text.split("\n").find((entry) => entry.startsWith("default "));
    const gateway = line?.match(/\bvia\s+(\S+)/)?.[1];
    const device = line?.match(/\bdev\s+(\S+)/)?.[1];
    return gateway && device ? { gateway, device } : null;
}

export function parseNeighbour(platform: NodeJS.Platform, text: string): string | null {
    const raw = platform === "darwin" ? text.match(/\sat\s+([0-9a-fA-F:]+)\s/)?.[1] : text.match(/\blladdr\s+(\S+)/)?.[1];
    return raw ? normalizeHardwareAddress(raw) : null;
}

async function gatewayAddress(platform: NodeJS.Platform): Promise<string> {
    const darwin = platform === "darwin";
    if (!darwin && platform !== "linux") throw new Error(`uplink: no gateway lookup on ${platform}`);
    const route = parseDefaultRoute(platform, darwin ? await output("/sbin/route", ["-n", "get", "default"])
        : await output("ip", ["route", "show", "default"]));
    if (!route) throw new Error("uplink: no default route; the network is unknown");
    const neighbour = async () => parseNeighbour(platform, darwin
        ? await output("/usr/sbin/arp", ["-n", route.gateway]).catch(() => "")
        : await output("ip", ["neigh", "show", route.gateway, "dev", route.device]).catch(() => ""));
    const first = await neighbour();
    if (first) return first;
    // A neighbour entry can have expired: one packet to the gateway brings it back.
    await output(darwin ? "/sbin/ping" : "ping", darwin ? ["-c", "1", "-t", "2", route.gateway] : ["-c", "1", "-W", "2", route.gateway]).catch(() => "");
    const second = await neighbour();
    if (!second) throw new Error(`uplink: the gateway ${route.gateway} has no hardware address; the network is unknown`);
    return second;
}

// What network this machine is on: its default gateway's hardware address (addresses and
// private ranges repeat between networks; that does not), or the configured probe's output.
export async function networkIdentity(probe?: readonly string[], platform: NodeJS.Platform = process.platform): Promise<string> {
    if (probe) {
        const identity = (await output(probe[0], probe.slice(1))).trim().toLowerCase();
        if (!identity) throw new Error("uplink: the network probe printed nothing");
        return identity;
    }
    return await gatewayAddress(platform);
}
