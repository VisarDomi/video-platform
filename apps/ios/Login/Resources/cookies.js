export async function readTangoLogin(api) {
    const tabs = await api.tabs.query({active: true, currentWindow: true});
    const active = tabs.length === 1 ? new URL(tabs[0].url) : null;
    if (!active || active.protocol !== 'https:' || !['tango.me', 'www.tango.me'].includes(active.hostname)) {
        throw new Error('Open Tango in the active Safari tab first.');
    }
    const stores = (await api.cookies.getAllCookieStores()).filter(store => store.tabIds.includes(tabs[0].id));
    if (stores.length !== 1) throw new Error('Unable to identify this Safari tab’s cookie store.');
    const cookies = new Map();
    const urls = [...new Set([
        new URL('/api/session-service/public/v2/session/web/refresh', active.origin).href,
        'https://www.tango.me/api/session-service/public/v2/session/web/refresh',
        'https://gateway.tango.me/session-service/public/v2/session/web/refresh',
        'https://gateway.tango.me/api/session-service/public/v2/session/web/refresh'
    ])];
    const tokenExpiry = value => {
        try {
            const part = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const bytes = Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), c => c.charCodeAt(0));
            const expiry = JSON.parse(new TextDecoder().decode(bytes)).exp;
            return typeof expiry === 'number' ? expiry : undefined;
        } catch { return undefined; }
    };
    for (const name of ['Tango-RT', 'Tango-DI', 'Tango-DeviceId', 'Tango-ST', 'Tango-WST', 'Tango-SD']) {
        for (const url of urls) {
            const cookie = await api.cookies.get({url, name, storeId: stores[0].id});
            if (!cookie || !(cookie.domain.replace(/^\./, '') === 'tango.me' || cookie.domain.endsWith('.tango.me'))) continue;
            const expirationDate = cookie.expirationDate ?? tokenExpiry(cookie.value) ?? Date.now() / 1000 + (name === 'Tango-ST' ? 3600 : 90 * 86400);
            cookies.set([cookie.name, cookie.domain, cookie.path].join('\x1f'), {name: cookie.name, value: cookie.value,
                domain: cookie.domain, path: cookie.path, expirationDate});
        }
    }
    return {cookies: [...cookies.values()]};
}
