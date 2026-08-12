import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const CONTRACT_KEY = "historical-finalization-v1";

export interface FinalizationContract {
    readonly status?: unknown;
    readonly completedAt?: unknown;
    readonly recordingCount?: unknown;
}

export function readFinalizationContract(databasePath: string): FinalizationContract | null {
    if (!existsSync(databasePath)) return null;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const row = database.prepare("SELECT value FROM finalization_meta WHERE key = ?")
            .get(CONTRACT_KEY) as { value: string } | undefined;
        if (!row) return null;
        const value = JSON.parse(row.value) as FinalizationContract;
        return value.status === "complete" ? value : null;
    } catch {
        return null;
    } finally {
        database.close();
    }
}
