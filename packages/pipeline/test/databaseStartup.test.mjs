import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {PipelineDatabase} from '../dist/db/pipelineDatabase.js';
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pipeline-db-startup-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'pipeline.sqlite');const db=new PipelineDatabase(file);
 const recording=db.discover({provider:'tango',sourceKind:'edited',sourcePath:path.join(root,'2026-11-01 120000 source'),playlistPath:path.join(root,'playlist.m3u8'),sourceFingerprint:'exact-source',durationSeconds:120});
 return {file,db,recording};
}
test('startup tolerates a concurrent writer longer than the former five-second timeout',async t=>{
 const f=await fixture(t);f.db.close();
 const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',`
 import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);
 db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');
 setTimeout(()=>{db.exec('ROLLBACK');db.close();},6200);
 `,f.file],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await once(child.stdout,'data');const exited=once(child,'exit');
 const reopened=new PipelineDatabase(f.file);
 assert.equal(reopened.get(f.recording.id).sourceFingerprint,'exact-source');
 assert.equal(reopened.integrityCheck(),'ok');reopened.close();await exited;
});
test('already initialized retention tables do not request a writer transaction on every open',async t=>{
 const {file,db}=await fixture(t);t.after(()=>db.close());
 const writer=new DatabaseSync(file);t.after(()=>writer.close());writer.exec('BEGIN IMMEDIATE');
 try{db.initializeRetention(false);}finally{writer.exec('ROLLBACK');}
});
test('an interrupted initial schema setup still creates the missing retention tables',async t=>{
 const {file,db,recording}=await fixture(t);db.close();const raw=new DatabaseSync(file);
 raw.exec('DROP TABLE local_source_presence');raw.close();
 const reopened=new PipelineDatabase(file);assert.equal(reopened.get(recording.id).sourceFingerprint,'exact-source');
 assert.equal(reopened.setLocalSourcePresence(recording.id,'present',null),true);reopened.close();
});
