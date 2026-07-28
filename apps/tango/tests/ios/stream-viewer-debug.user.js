// ==UserScript==
// @name         stream-viewer-debug 1
// @namespace    https://github.com/VisarDomi/debug
// @version      1
// @description  Remote Safari debugger controlled by this PC.
// @match        http://*/*
// @match        https://*/*
// @connect      192.168.1.197
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const SERVER = 'https://192.168.1.197:36666';
    const POLL_MS = 750;
    const CLIENT_ID = `ios-${typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
    let lastCommandId = 0;

    function request(method, path, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: SERVER + path,
                headers: data ? { 'Content-Type': 'application/json' } : {},
                data: data ? JSON.stringify(data) : undefined,
                timeout: 15000,
                onload: resolve,
                onerror: reject,
                ontimeout: reject,
            });
        });
    }

    function describe(value) {
        if (value === undefined) return { type: 'undefined' };
        if (value === null) return null;
        if (value instanceof Element) {
            return {
                type: 'Element',
                tagName: value.tagName,
                id: value.id,
                className: value.className,
                outerHTML: value.outerHTML.slice(0, 20000),
            };
        }
        if (value instanceof Error) {
            return { type: value.name, message: value.message, stack: value.stack || '' };
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return { type: typeof value, value: String(value) };
        }
    }

    async function report(payload) {
        try {
            await request('POST', '/__debug_result', {
                client: CLIENT_ID,
                href: location.href,
                timestamp: new Date().toISOString(),
                ...payload,
            });
        } catch {
            // Debug transport must never affect the inspected page.
        }
    }

    async function execute(command) {
        lastCommandId = Math.max(lastCommandId, command.id);
        const startedAt = performance.now();
        try {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const value = await new AsyncFunction(command.code)();
            await report({
                event: 'command-result',
                commandId: command.id,
                ok: true,
                durationMs: Math.round(performance.now() - startedAt),
                result: describe(value),
            });
        } catch (error) {
            await report({
                event: 'command-result',
                commandId: command.id,
                ok: false,
                durationMs: Math.round(performance.now() - startedAt),
                error: describe(error),
            });
        }
    }

    async function poll() {
        const query = new URLSearchParams({
            client: CLIENT_ID,
            after: String(lastCommandId),
            href: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
        });
        try {
            const response = await request('GET', `/__debug_poll?${query}`);
            if (response.status >= 200 && response.status < 300) {
                const payload = JSON.parse(response.responseText);
                for (const command of payload.commands || []) await execute(command);
                lastCommandId = Math.max(lastCommandId, payload.cursor || 0);
            }
        } catch {
            // Keep reconnecting while the page remains alive.
        }
        setTimeout(poll, POLL_MS);
    }

    addEventListener('error', event => {
        void report({
            event: 'page-error',
            message: event.message,
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
            error: describe(event.error),
        });
    }, true);

    addEventListener('unhandledrejection', event => {
        void report({ event: 'unhandled-rejection', reason: describe(event.reason) });
    });

    void report({
        event: 'connected',
        title: document.title,
        readyState: document.readyState,
        userAgent: navigator.userAgent,
    });
    void poll();
})();
