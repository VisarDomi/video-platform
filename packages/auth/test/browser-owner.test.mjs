import test from 'node:test';
import assert from 'node:assert/strict';
import {browserPair} from '../dist/providers/tango/tangoBrowserOwner.js';
import {TangoAuthProvider} from '../dist/providers/tango/tangoAuthProvider.js';
const token=(session,exp,extra={})=>'header.'+Buffer.from(JSON.stringify({accountId:'account',sessionId:session,iat:exp-3600,exp,...extra})).toString('base64url')+'.signature';
const cookie=(name,value,domain='www.tango.me')=>({name,value,domain,path:'/'});
test('persistent profile selects coherent, unexpired first-party credentials',()=>{
 const exp=Math.floor(Date.now()/1000)+3600;
 const rt=token('current',exp),st=token('current',exp);
 const bag=browserPair([cookie('Tango-RT',token('expired',1)),cookie('Tango-ST',token('other',exp)),cookie('Tango-RT',rt),cookie('Tango-ST',st),cookie('Tango-RT',token('hostile',exp+100),'tango.me.evil.invalid')]);
 assert.equal(bag.refreshToken,rt);assert.equal(bag.sessionToken,st);
 assert.equal(browserPair([cookie('Tango-RT',token('visitor',exp,{guest:true})),cookie('Tango-ST',token('visitor',exp,{guest:true}))]),null);
});
test('profile ownership survives serialization and migrates an old cookie-only login once',()=>{
 const provider=new TangoAuthProvider(),bag={refreshToken:'fixture-refresh',sessionToken:'fixture-access',extras:{tangoBrowserProfile:'pc-fixture'}};
 assert.equal(provider.needsSessionMigration(bag),false);
 assert.equal(provider.deserializeTokens(provider.serializeTokens(bag)).extras.tangoBrowserProfile,'pc-fixture');
 assert.equal(provider.needsSessionMigration({...bag,extras:{}}),true);
});
