import { readFile } from "node:fs/promises";

// The disk's state now, for a warning about a slow durable write: the kernel's I/O pressure
// (the share of the last 10 seconds some or all tasks waited for I/O) and the dirty and
// writeback page cache an fsync may wait behind. Unreadable fields are left out.
export async function diskPressureSummary(procRoot = "/proc"): Promise<string> {
    const parts: string[] = [];
    const pressure = await readFile(`${procRoot}/pressure/io`, "utf8").catch(() => "");
    for (const kind of ["some", "full"]) {
        const value = pressure.match(new RegExp(`^${kind}\\s+avg10=([\\d.]+)`, "m"))?.[1];
        if (value !== undefined) parts.push(`io${kind}10=${value}%`);
    }
    const meminfo = await readFile(`${procRoot}/meminfo`, "utf8").catch(() => "");
    for (const [field, name] of [["Dirty", "dirty"], ["Writeback", "writeback"]]) {
        const kib = meminfo.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m"))?.[1];
        if (kib !== undefined) parts.push(`${name}=${Math.round(Number(kib) / 1024)}MB`);
    }
    return parts.join(" ");
}
