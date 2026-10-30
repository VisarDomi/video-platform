import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { pipelineConfig } from '../dist/config.js';
import { PipelineDatabase } from '../dist/db/pipelineDatabase.js';
import { sessionFingerprint, writePorntrexSession } from '../dist/upload/porntrexSession.js';
import { readRecoveryState, writeRecoveryState, withRecoveryLock, recoveryInProgress } from '../dist/upload/sessionRecoveryState.js';
import { SESSION_LOST_ADVICE } from '../dist/upload/providerWarnings.js';
import { maintainPorntrexSession } from '../dist/commands/maintainPorntrexSession.js';
import { recoverPorntrexSession } from '../dist/commands/recoverPorntrexSession.js';
import { keepPorntrexSessionAlive } from '../dist/commands/runCampaignWorker.js';
import { readPorntrexSession } from '../dist/upload/porntrexSession.js';
const oldLogin='2026-10-22T13:29:39.556Z', now=new Date('2026-10-30T12:00:00Z');
const cookies=[{name:'PHPSESSID',value:'synthetic-only',domain:'.porntrex.com',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'Lax'}];
const fingerprint=sessionFingerprint(cookies);
async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'ptrex-auto-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config={...pipelineConfig,databasePath:path.join(root,'pipeline.sqlite'),porntrexSessionPath:path.join(root,'session.json'),porntrexBrowserProfilePath:path.join(root,'profile'),networkUploadsEnabled:false};
 const db=new PipelineDatabase(config.databasePath);t.after(()=>db.close());db.setCampaignState('paused');
 db.discover({provider:'tango',sourceKind:'edited',sourcePath:path.join(root,'original'),playlistPath:path.join(root,'original/playlist.m3u8'),sourceFingerprint:'precious',durationSeconds:200});
 const store=login=>writePorntrexSession(config.porntrexSessionPath,{version:1,cookies,passwordLoginAt:login,savedAt:login});
 const ack=login=>db.recordProviderSessionEvent({provider:'porntrex',kind:'phone_connected',loggedIn:true,fingerprint,passwordLoginAt:login,note:'both verified'},now);
 await store(oldLogin);ack(oldLogin);
 return {root,config,db,store,ack};
}
const checkResult=(loggedIn,passwordLoginAt=oldLogin)=>({loggedIn,fingerprint,passwordLoginAt,note:loggedIn?'upload form served':'redirected to /'});

test('two confirmed sign-outs automatically recover without changing the upload hold or queue',async t=>{
 const f=await fixture(t), before=f.db.getCampaignControl(), queue=f.db.list();let good=false,calls=0,logins=[];
 const result=await maintainPorntrexSession(f.config,now,{check:async()=>{calls++;return checkResult(good);},notify:()=>{},recover:async allow=>{logins.push(allow);good=true;}});
 assert.equal(result.disposition,'recovered');assert.equal(calls,3);assert.deepEqual(logins,[true]);
 assert.deepEqual(f.db.getCampaignControl(),before);assert.deepEqual(f.db.list(),queue);
 assert.equal((await readRecoveryState(f.config.databasePath)).status,'healthy');
});

test('partial recovery queues the phone and retries delivery without another password login',async t=>{
 const f=await fixture(t);let good=false,epoch=oldLogin,attempts=[];
 const deps={check:async()=>checkResult(good,epoch),notify:()=>{},recover:async allow=>{
  attempts.push(allow);if(allow){good=true;epoch=now.toISOString();await f.store(epoch);throw new Error('phone temporarily unreachable');}
  f.ack(epoch);
 }};
 assert.equal((await maintainPorntrexSession(f.config,now,deps)).disposition,'phone_pending');
 assert.equal((await readRecoveryState(f.config.databasePath)).status,'phone_pending');
 assert.equal((await maintainPorntrexSession(f.config,new Date(now.getTime()+60_000),deps)).disposition,'phone_pending');
 assert.deepEqual(attempts,[true],'delivery backoff must not repeat login');
 assert.equal((await maintainPorntrexSession(f.config,new Date(now.getTime()+11*60_000),deps)).disposition,'phone_synced');
 assert.deepEqual(attempts,[true,false]);
 assert.equal((await maintainPorntrexSession(f.config,new Date(now.getTime()+22*60_000),deps)).disposition,'logged_in');
 assert.deepEqual(attempts,[true,false]);
});

test('inconclusive network responses or a recovered second probe never authorize a password login',async t=>{
 const f=await fixture(t);let calls=0;
 const recover=async()=>assert.fail('must not log in');
 assert.equal((await maintainPorntrexSession(f.config,now,{check:async()=>{throw new Error('HTTP 503');},recover,notify:()=>{}})).disposition,'unavailable');
 assert.equal((await maintainPorntrexSession(f.config,now,{check:async()=>checkResult(++calls===2),recover,notify:()=>{}})).disposition,'session_changed');
});

test('failed recovery is durably rate limited across later timer invocations',async t=>{
 const f=await fixture(t);let attempts=0;
 const deps={check:async()=>checkResult(false),notify:()=>{},recover:async()=>{attempts++;throw new Error('login failed');}};
 assert.equal((await maintainPorntrexSession(f.config,now,deps)).disposition,'recovery_deferred');
 assert.equal((await maintainPorntrexSession(f.config,new Date(now.getTime()+10*60_000),deps)).disposition,'recovery_backoff');
 assert.equal(attempts,1);
 assert.equal((await maintainPorntrexSession(f.config,new Date(now.getTime()+31*60_000),deps)).disposition,'recovery_deferred');
 assert.equal(attempts,2);
 assert.equal(Date.parse((await readRecoveryState(f.config.databasePath)).retryAfter),now.getTime()+91*60_000);
});

test('kernel recovery lock excludes concurrent timer/manual attempts and releases on failure',async t=>{
 const f=await fixture(t);
 await assert.rejects(withRecoveryLock(f.config.databasePath,async()=>{
  assert.equal(await recoveryInProgress(f.config.databasePath),true);
  assert.equal((await withRecoveryLock(f.config.databasePath,async()=>assert.fail('double login'))).acquired,false);
  assert.equal((await maintainPorntrexSession(f.config,now,{check:async()=>assert.fail('lock held'),notify:()=>{}})).disposition,'recovery_busy');
  throw new Error('interrupted repair');
 }),/interrupted repair/);
 assert.equal(await recoveryInProgress(f.config.databasePath),false);
 assert.equal((await withRecoveryLock(f.config.databasePath,async()=>true)).acquired,true);
});

test('a live auth-paused worker can recover, while a running worker cannot have its session replaced',async t=>{
 const f=await fixture(t);f.db.writeWorkerHeartbeat(now);
 const deps={check:async()=>checkResult(false),recover:async()=>assert.fail('running worker'),notify:()=>{}};
 assert.equal((await maintainPorntrexSession(f.config,now,deps)).disposition,'worker_active');
 f.db.pauseForAttention(`Porntrex authentication ended; ${SESSION_LOST_ADVICE}`,now);
 const before=f.db.getCampaignControl();let good=false;
 assert.equal((await maintainPorntrexSession(f.config,now,{...deps,check:async()=>checkResult(good),recover:async()=>{good=true;}})).disposition,'recovered');
 assert.deepEqual(f.db.getCampaignControl(),before);
});


test('a valid phone session is reused before any password login, while an unavailable phone defers login',async t=>{
 const f=await fixture(t);let logins=0,delivered=0;
 const phoneCookies=[{...cookies[0],value:'phone-live'}];
 const deps={phone:{readSession:async()=>[cookies[0],...phoneCookies],connect:async supplied=>{delivered++;assert.equal(supplied[0].value,'phone-live');return {loggedIn:true,host:'www.porntrex.com',finalPath:'/upload-video/'};}},
  check:async file=>{const s=await readPorntrexSession(file);return {...checkResult(s.cookies[0].value==='phone-live'),fingerprint:sessionFingerprint(s.cookies)};},openBrowser:async()=>{logins++;}};
 const before=f.db.getCampaignControl();
 await withRecoveryLock(f.config.databasePath,()=>recoverPorntrexSession(f.config,true,deps));
 assert.equal(logins,0);assert.equal(delivered,1);assert.equal((await readPorntrexSession(f.config.porntrexSessionPath)).cookies[0].value,'phone-live');
 assert.deepEqual(f.db.getCampaignControl(),before);
 await f.store(oldLogin);
 await assert.rejects(recoverPorntrexSession(f.config,true,{...deps,phone:{...deps.phone,readSession:async()=>{throw new Error('phone offline');}}}),/phone offline/);
 assert.equal(logins,0,'must not invalidate an unreachable phone');
});

test('queued phone synchronization uses the valid PC session without opening a browser',async t=>{
 const f=await fixture(t);let delivered=0;
 await recoverPorntrexSession(f.config,false,{phone:{readSession:async()=>assert.fail('healthy PC does not need phone inspection'),connect:async()=>{delivered++;return {loggedIn:true,host:'www.porntrex.com',finalPath:'/upload-video/'};}},check:async()=>checkResult(true),openBrowser:async()=>assert.fail('must not reauthenticate')});
 assert.equal(delivered,1);
});


test('an authentication pause cannot resume until the phone handoff is healthy; a gaming hold remains authoritative',async t=>{
 const f=await fixture(t);f.config.networkUploadsEnabled=true;
 f.db.pauseForAttention(`Porntrex authentication ended; ${SESSION_LOST_ADVICE}`,now);
 await writeRecoveryState(f.config.databasePath,{version:1,failures:1,status:'phone_pending'});
 await keepPorntrexSessionAlive(f.config,now,async()=>checkResult(true));
 assert.equal(f.db.getCampaignControl().state,'paused');
 await writeRecoveryState(f.config.databasePath,{version:1,failures:0,status:'healthy'});
 await keepPorntrexSessionAlive(f.config,now,async()=>checkResult(true));
 assert.equal(f.db.getCampaignControl().state,'running');
 f.db.pauseForAttention(`Porntrex authentication ended; ${SESSION_LOST_ADVICE}`,now);
 const {writeFile}=await import('node:fs/promises');await writeFile(path.join(f.root,'user-pause.json'),'{}');
 await keepPorntrexSessionAlive(f.config,now,async()=>checkResult(true));
 assert.equal(f.db.getCampaignControl().state,'paused');
});

test('a manually paused live worker still gets authentication repair without resuming processing',async t=>{
 const f=await fixture(t),before=f.db.getCampaignControl();f.db.writeWorkerHeartbeat(now);
 f.db.recordProviderSessionEvent({provider:'porntrex',kind:'keepalive',loggedIn:false,fingerprint,passwordLoginAt:oldLogin,note:'worker detected expiry'},now);
 let good=false;
 assert.equal((await maintainPorntrexSession(f.config,now,{check:async()=>checkResult(good),notify:()=>{},recover:async()=>{good=true;}})).disposition,'recovered');
 assert.deepEqual(f.db.getCampaignControl(),before);
});

test('phone unavailability retries promptly and does not consume password-failure backoff',async t=>{
 const f=await fixture(t);const {RecoveryDeferredError}=await import('../dist/upload/sessionRecoveryState.js');
 const deps={check:async()=>checkResult(false),notify:()=>{},recover:async()=>{throw new RecoveryDeferredError('phone offline');}};
 await maintainPorntrexSession(f.config,now,deps);
 const state=await readRecoveryState(f.config.databasePath);
 assert.equal(state.failures,0);assert.equal(Date.parse(state.retryAfter),now.getTime()+10*60_000);
});

test('SIGKILL releases the cross-process recovery lock without stale-file repair',async t=>{
 const f=await fixture(t),{spawn}=await import('node:child_process'),{once}=await import('node:events');
 const moduleURL=new URL('../dist/upload/sessionRecoveryState.js',import.meta.url).href;
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {withRecoveryLock} from ${JSON.stringify(moduleURL)}; await withRecoveryLock(${JSON.stringify(f.config.databasePath)},async()=>{setInterval(()=>{},1000);console.log('locked');await new Promise(()=>{});});`],{stdio:['ignore','pipe','pipe'],env});
 t.after(()=>child.kill('SIGKILL'));
 const first = await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('lock child did not start')),5000);timer.unref();})]); assert.match(String(first[0]),/locked/);
 assert.equal(await recoveryInProgress(f.config.databasePath),true);
 const closed=once(child,'close');child.kill('SIGKILL');await closed;
 assert.equal((await withRecoveryLock(f.config.databasePath,async()=>true)).acquired,true);
});

test('a crash before saving a reused PHP login timestamp still retries phone acknowledgement',async t=>{
 const f=await fixture(t);let permissions=[];
 await writeRecoveryState(f.config.databasePath,{version:1,failures:1,status:'recovering',retryAfter:new Date(now.getTime()+30*60_000).toISOString()});
 const result=await maintainPorntrexSession(f.config,now,{check:async()=>checkResult(true),notify:()=>{},recover:async allow=>permissions.push(allow)});
 assert.equal(result.disposition,'phone_synced');assert.deepEqual(permissions,[false]);
 assert.equal((await readRecoveryState(f.config.databasePath)).status,'healthy');
});
