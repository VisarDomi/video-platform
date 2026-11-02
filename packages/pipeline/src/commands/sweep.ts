import { access } from 'node:fs/promises';
import type { PipelineConfig } from '../config.js';
import type { PipelineDatabase } from '../db/pipelineDatabase.js';

// Presence is independent of receipts, remote monitoring and cleanup. A user
// deleting/restoring originals never erases history or authorizes media deletion.
export async function sweepMissingRecordings(database: PipelineDatabase,
    _config: Pick<PipelineConfig, 'cleanupEnabled' | 'stagingRoot'>, now = new Date()) {
    const changes: Array<{recordingId:string;provider:string;reason:string}>=[];
    if(database.getComparisonTrial()) return changes;
    for(const recording of database.list()) {
        try {
            await access(recording.sourcePath);
            database.setLocalSourcePresence(recording.id,'present',null,now);
        } catch(error) {
            const code=(error as NodeJS.ErrnoException).code;
            const missing=code==='ENOENT'||code==='ENOTDIR';
            const reason=missing?'source folder missing; history retained':`source inaccessible: ${code}`;
            if(database.setLocalSourcePresence(recording.id,missing?'missing':'unavailable',reason,now)) {
                changes.push({recordingId:recording.id,provider:recording.provider,reason});
            }
        }
    }
    return changes;
}
