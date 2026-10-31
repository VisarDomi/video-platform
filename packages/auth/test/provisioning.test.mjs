import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TangoBrowserOwner} from '../dist/providers/tango/tangoBrowserOwner.js';
import {withLoginLease} from '../dist/browser/loginLease.js';
const token=()=>`header.${Buffer.from(JSON.stringify({accountId:'account',sessionId:'phone',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;

test('initial handoff stops and clears the setup browser, preserves Google SSO, and retries without another login',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tango-provision-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const events=[];let pages=[],closed=false,opens=0;
 let cookies=['Tango-RT','Tango-ST','Tango-DI','Tango-DeviceId','Tango-SD'].map(name=>({name,value:name==='Tango-RT'||name==='Tango-ST'?token():'device',domain:'www.tango.me',path:'/',expires:Date.now()/1000+3600,httpOnly:true,secure:true}));
 cookies.push({name:'Google-SSO',value:'fixture',domain:'accounts.google.com',path:'/'});
 const page=()=>{const value={async close(){events.push('page-close');pages=pages.filter(x=>x!==value);}};return value;};pages=[page()];
 const context={async cookies(){return structuredClone(cookies);},pages(){return pages;},async newPage(){const p=page();pages.push(p);return p;},
  async newCDPSession(){return{async send(_,args){events.push('clear:'+args.origin);}};},
  async clearCookies({domain}){events.push('clear-cookies');cookies=cookies.filter(c=>!domain.test(c.domain));},async close(){closed=true;events.push('browser-close');}};
 const owner=new TangoBrowserOwner('fixture');owner.directory=dir;owner.journal=path.join(dir,'owner-session.json');owner.open=async()=>{opens++;owner.context=context;return context;};
 const result=await owner.provision({email:'fixture@example.invalid',password:'unused',provider:'tango'},'fixture-request-12345678');
 assert.equal(result.cookies.length,5);assert(closed);assert(events.indexOf('page-close')<events.indexOf('clear-cookies'));
 assert.deepEqual(cookies.map(c=>c.name),['Google-SSO']);
 assert(!(await readdir(dir)).includes('owner-session.json'));
 assert.deepEqual((await owner.provision({},'fixture-request-12345678')),result);assert.equal(opens,1);
 await owner.acknowledgeProvision('fixture-request-12345678');assert(!(await readdir(dir)).includes('handoff.json'));
});

test('PC and phone initial Google flows share one account lease',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tango-login-lease-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let active=0,peak=0;
 const run=()=>withLoginLease('fixture@example.invalid',async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;},dir);
 await Promise.all([run(),run()]);assert.equal(peak,1);assert.deepEqual(await readdir(dir),[]);
});
