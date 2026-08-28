import type { PlaylistFetchFailure } from "../core/interfaces.js";

export interface AccessIncidentSnapshot {
    startedAt: number;
    attempts: number;
    failures: Record<string, number>;
    firstFailure: PlaylistFetchFailure;
    lastFailure: PlaylistFetchFailure;
}

export interface ClosedAccessIncident extends AccessIncidentSnapshot {
    durationMs: number;
    outcome: string;
}

function failureKey(failure: PlaylistFetchFailure): string {
    if (failure.kind === "http") return `http-${failure.status ?? "unknown"}`;
    return failure.kind;
}

export class AccessIncidentTracker {
    private incident: AccessIncidentSnapshot | null = null;

    public record(failure: PlaylistFetchFailure, now = Date.now()): { opened: boolean; snapshot: AccessIncidentSnapshot } {
        const opened = this.incident === null;
        if (!this.incident) {
            this.incident = {
                startedAt: now,
                attempts: 0,
                failures: {},
                firstFailure: failure,
                lastFailure: failure,
            };
        }

        this.incident.attempts++;
        this.incident.lastFailure = failure;
        const key = failureKey(failure);
        this.incident.failures[key] = (this.incident.failures[key] ?? 0) + 1;
        return { opened, snapshot: this.snapshot()! };
    }

    public close(outcome: string, now = Date.now()): ClosedAccessIncident | null {
        if (!this.incident) return null;
        const closed = {
            ...this.snapshot()!,
            durationMs: Math.max(0, now - this.incident.startedAt),
            outcome,
        };
        this.incident = null;
        return closed;
    }

    public snapshot(): AccessIncidentSnapshot | null {
        if (!this.incident) return null;
        return {
            ...this.incident,
            failures: { ...this.incident.failures },
            firstFailure: { ...this.incident.firstFailure },
            lastFailure: { ...this.incident.lastFailure },
        };
    }
}
