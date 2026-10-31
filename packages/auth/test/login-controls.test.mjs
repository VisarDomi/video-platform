import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {findAndClickLoginButton} from '../dist/providers/tango/tangoLogin.js';

for (const variant of ['test-id','label-only','hidden-old-button','hydration']) test(`Tango login control: ${variant}`, {skip: !process.env.DISPLAY}, async () => {
    const browser = await chromium.launch({headless:false,env:{...process.env,DISPLAY:':111'},args:['--disable-gpu']});
    try {
        const page=await browser.newPage();
        await page.setContent(`<button data-testid="visitor-join-now" ${variant==='hydration'?'':'onclick="document.querySelector(\'#login\').hidden=false"'}>Sign in</button>
            ${variant==='hidden-old-button'?'<button hidden data-testid="GOOGLE">Hidden old control</button>':''}
            <div id="login" hidden><button ${variant==='test-id'?'data-testid="GOOGLE"':''} onclick="window.clicked=true"><span>Continue with Google</span></button></div>
            ${variant==='hydration'?"<script>setTimeout(()=>{document.querySelector('[data-testid=visitor-join-now]').onclick=()=>document.querySelector('#login').hidden=false},150)</script>":''}`);
        await findAndClickLoginButton(page,{email:'fixture@example.invalid',password:'unused',provider:'tango'});
        assert.equal(await page.evaluate(()=>window.clicked),true);
    } finally { await browser.close(); }
});
