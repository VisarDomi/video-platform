import { setTimeout as delay } from "node:timers/promises";

let stopping = false;

// Called by the service's SIGTERM/SIGINT handler.
export function markStopping(): void {
    stopping = true;
}

// Whether the service is stopping. systemd signals the whole unit at once, so a
// stage's child process (ffmpeg, llama-server) can die and fail the stage just
// before this process sees its own signal: wait up to graceMs for it.
export async function stopRequested(graceMs = 1000): Promise<boolean> {
    if (stopping) return true;
    await delay(graceMs);
    return stopping;
}
