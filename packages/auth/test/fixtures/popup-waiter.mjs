import assert from 'node:assert/strict';
import { runLoginFlow } from '../../dist/providers/tango/tangoLogin.js';

let closePopup, closeResponse;
const mode = process.argv[2];
const popup = new Promise((_, reject) => { closePopup = () => reject(new Error('popup target closed')); });
const response = new Promise((_, reject) => { closeResponse = () => reject(new Error('response target closed')); });
const visitor = { or() { return this; }, first() { return this; }, async click() {} };
const google = { or() { return this; }, filter() { return this; }, first() { return this; }, async click() {
    if (mode !== 'popup-error') throw new Error('login trigger timed out');
}, async isVisible() { return true; }, async waitFor() {} };
const page = {
    waitForEvent: () => popup,
    async goto() {
        if (mode !== 'cleanup') {
            closePopup();
            await new Promise(resolve => setImmediate(resolve));
        }
    },
    getByTestId: id => id === 'GOOGLE' ? google : visitor,
    getByText: () => google,
    isClosed: () => false,
    async screenshot() {},
};
const browser = {
    async newContext() { return { async newPage() { return page; }, waitForEvent: () => response }; },
    async close() { closePopup(); closeResponse(); },
};

await assert.rejects(runLoginFlow(browser, { email: 'fixture@example.invalid', password: 'fixture' }),
    mode === 'popup-error' ? /popup target closed/ : /login trigger timed out/);
await browser.close();
await new Promise(resolve => setImmediate(resolve));
console.log('handled original login failure and browser cleanup');
