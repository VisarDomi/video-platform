import { lstat, realpath, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import type { PipelineDatabase } from '../db/pipelineDatabase.js';
import type { PipelineConfig } from '../config.js';
import { artifactSha256 } from '../stages/validateArtifact.js';

// Receipt -> unlink -> fsync -> deletion checkpoint. A crash at any boundary
// is idempotent. Keep the artifact rows: verification and audit need their IDs.
export async function cleanupAcceptedConversions(database: PipelineDatabase,
    config: Pick<PipelineConfig, 'cleanupEnabled' | 'stagingRoot'> & Partial<Pick<PipelineConfig, 'artifactsRoot'>>, now = new Date()) {
    const results: Array<{recordingId:string; bytes:number; disposition:string; error?:string; reason?:string}> = [];
    if (!config.cleanupEnabled || database.getComparisonTrial()) return results;
    for (const receipt of database.pendingAcceptedConversions()) {
        try {
            const root=path.resolve(config.artifactsRoot ?? config.stagingRoot);
            const file=path.resolve(receipt.path);
            if (!file.startsWith(root+path.sep) || !file.endsWith('.mp4')
                || file.startsWith(path.resolve(receipt.sourcePath)+path.sep)) throw new Error('conversion path is outside managed staging');
            const info=await lstat(file).catch((error:NodeJS.ErrnoException)=>{
                if(error.code==='ENOENT') return null;
                throw error;
            });
            if (info) {
                if (!info.isFile() || await realpath(file)!==file || info.size!==receipt.sizeBytes
                    || await artifactSha256(file)!==receipt.sha256) throw new Error('conversion no longer matches the accepted receipt');
                // Recheck inode/stat after hashing so replacements cannot inherit
                // the old acceptance. The managed worker owns this path single-flight.
                const current=await lstat(file);
                if(current.ino!==info.ino || current.mtimeMs!==info.mtimeMs || current.size!==info.size) throw new Error('conversion changed during cleanup');
                await unlink(file);
            }
            const directory=await open(path.dirname(file),'r');
            try {await directory.sync();} finally {await directory.close();}
            database.recordConversionDeletion(receipt.attemptId,null,now);
            results.push({recordingId:receipt.recordingId,bytes:info?.size??0,disposition:'conversion_deleted'});
        } catch(error) {
            const message=String(error);
            database.recordConversionDeletion(receipt.attemptId,message,now);
            results.push({recordingId:receipt.recordingId,bytes:0,error:message,reason:message,disposition:'conversion_cleanup_failed'});
        }
    }
    return results;
}
