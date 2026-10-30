import test from 'node:test';
import assert from 'node:assert/strict';
import {readTangoLogin} from '../Login/Resources/cookies.js';

const jwt=exp=>'header.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.signature';
function api(records,host='www.tango.me') {
    return {tabs:{query:async()=>[{id:7,url:'https://'+host+'/'}]},cookies:{
        getAllCookieStores:async()=>[{id:'selected',tabIds:[7]},{id:'other',tabIds:[8]}],
        get:async query=>{
            assert.equal(query.storeId,'selected');
            return records.find(c=>c.name===query.name&&query.url===c.url)??null;
        }}};
}
test('Safari import reads current first-party API cookies and retains legacy scopes',async()=>{
    const exp=Math.floor(Date.now()/1000)+3600;
    const current='https://www.tango.me/api/session-service/public/v2/session/web/refresh';
    const legacy='https://gateway.tango.me/session-service/public/v2/session/web/refresh';
    const records=[{url:current,name:'Tango-RT',value:jwt(exp),domain:'www.tango.me',path:'/api/session-service/public/v2/session/web/refresh'},
        {url:current,name:'Tango-ST',value:jwt(exp),domain:'.tango.me',path:'/'},
        {url:legacy,name:'Tango-RT',value:'legacy-fixture',domain:'gateway.tango.me',path:'/session-service/public/v2/session/web/refresh',expirationDate:exp}];
    const {cookies}=await readTangoLogin(api(records));
    assert.equal(cookies.length,3);
    assert(cookies.some(c=>c.name==='Tango-RT'&&c.domain==='www.tango.me'));
    assert(cookies.every(c=>c.expirationDate===exp));
});
test('Safari import rejects an unrelated active tab',async()=>{
    await assert.rejects(readTangoLogin(api([],'tango.me.evil.invalid')),/Open Tango/);
});
test('the same cookie returned for multiple paths is deduplicated',async()=>{
    const shared={name:'Tango-ST',value:'fixture',domain:'.tango.me',path:'/',expirationDate:9999999999};
    const mock=api([]);mock.cookies.get=async q=>q.name==='Tango-ST'?shared:null;
    assert.equal((await readTangoLogin(mock)).cookies.length,1);
});
