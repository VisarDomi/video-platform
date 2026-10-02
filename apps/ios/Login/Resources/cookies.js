export async function readTangoLogin(api) {
    const tabs = await api.tabs.query({active: true, currentWindow: true});
    if (tabs.length !== 1 || !['tango.me', 'www.tango.me'].includes(new URL(tabs[0].url).hostname)) {
        throw new Error('Open Tango in the active Safari tab first.');
    }
    const stores = (await api.cookies.getAllCookieStores()).filter(store => store.tabIds.includes(tabs[0].id));
    if (stores.length !== 1) throw new Error('Unable to identify this Safari tab’s cookie store.');
    const cookies = [];
    for (const name of ['Tango-RT', 'Tango-DI', 'Tango-DeviceId', 'Tango-ST', 'Tango-WST']) {
        const cookie = await api.cookies.get({url: 'https://gateway.tango.me/session-service/public/v2/session/web/refresh',
            name, storeId: stores[0].id});
        if (cookie) cookies.push({name: cookie.name, value: cookie.value, domain: cookie.domain,
            path: cookie.path, expirationDate: cookie.expirationDate});
    }
    return {cookies};
}
