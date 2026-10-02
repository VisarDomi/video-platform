const button = document.querySelector('#import');
const status = document.querySelector('#status');
button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Importing…';
    try {
        const {cookies} = await readTangoLogin(browser);
        if (!cookies.some(c => c.name === 'Tango-RT')) {
            status.textContent = 'No Tango login found. Sign in on tango.me and allow this helper access to Tango websites.';
            return;
        }
        const response = await browser.runtime.sendNativeMessage('com.visar.Tango.paid', {
            operation: 'importTangoLogin', login: {cookies}
        });
        status.textContent = response?.ok ? 'Login saved. Close Tango tabs and remove tango.me in Safari Settings → Advanced → Website Data. Then open Tango and confirm cleanup. Do not use Log out.' : 'Import failed. Check website access and try again.';
    } catch {
        status.textContent = 'Import failed. Check website access and try again.';
    } finally {
        button.disabled = false;
    }
});
import {readTangoLogin} from './cookies.js';
