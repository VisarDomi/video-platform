import { profilingLogger } from "../core/logger.js";
import { PROFILING } from "../core/constants.js";

interface Lap {
    name: string;
    time: bigint;
}

interface ProfileSession {
    start: bigint;
    laps: Lap[];
}

const activeProfiles = new Map<string, ProfileSession>();

export function start(id: string): void {
    activeProfiles.set(id, {
        start: process.hrtime.bigint(),
        laps: [],
    });
}

export function lap(id: string, name: string): void {
    const session = activeProfiles.get(id);
    if (session) {
        session.laps.push({ name, time: process.hrtime.bigint() });
    }
}

export function end(id: string): ProfileSession | undefined {
    const session = activeProfiles.get(id);
    if (session) {
        lap(id, "end");
        activeProfiles.delete(id);
    }
    return session;
}

export function logSlowRequest(requestInfo: { method: string; path: string; status: number }, session: ProfileSession): void {
    const totalDurationNs = session.laps[session.laps.length - 1].time - session.start;
    const totalDurationMs = Number(totalDurationNs) / 1e6;

    if (totalDurationMs < PROFILING.SLOW_REQUEST_THRESHOLD_MS) {
        return;
    }

    let lastTime = session.start;
    const breakdown = session.laps
        .map((currentLap) => {
            const durationMs = (Number(currentLap.time - lastTime) / 1e6).toFixed(3);
            lastTime = currentLap.time;
            return `${currentLap.name}: ${durationMs}ms`;
        })
        .join(" -> ");

    const logMessage = `[SLOW] ${requestInfo.method} ${requestInfo.path} | Total: ${totalDurationMs.toFixed(3)}ms | Status: ${
        requestInfo.status
    } | Breakdown: ${breakdown}`;
    profilingLogger.info(logMessage);
}
