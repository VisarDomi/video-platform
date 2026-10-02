import { xvideos } from '../providers/xvideos.js';
import { startExtension } from './boot.js';
import { startCookiePersistence, type CookieApi } from './cookies.js';

startExtension(xvideos, ['xvideos.com', 'www.xvideos.com'], () => {
    const scope = globalThis as typeof globalThis & { browser?: CookieApi; chrome?: CookieApi };
    const api = scope.browser ?? scope.chrome;
    if (api) startCookiePersistence(api);
});
