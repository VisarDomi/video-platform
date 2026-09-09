// Cookie values stay inside the extension/cookie store; never put them in page
// localStorage or send them to the content script. Preserve deliberate logout.
export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    storeId: string;
    hostOnly: boolean;
    secure: boolean;
    httpOnly: boolean;
    session: boolean;
    expirationDate?: number;
    sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
}

export interface CookieApi {
    cookies: {
        get(details: { url: string; name: string; storeId: string }): Promise<Cookie | null>;
        getAllCookieStores(): Promise<{ id: string; incognito: boolean }[]>;
        set(details: {
            url: string; name: string; value: string; domain?: string; path: string;
            storeId: string; secure: boolean; httpOnly: boolean; sameSite: Cookie["sameSite"];
            expirationDate: number;
        }): Promise<Cookie | null>;
        onChanged: { addListener(listener: (change: { removed: boolean; cookie: Cookie }) => void): void };
    };
    runtime: {
        onInstalled: { addListener(listener: () => void): void };
        onStartup: { addListener(listener: () => void): void };
    };
    extension?: { inIncognitoContext?: boolean };
    webRequest: {
        onCompleted: { addListener(listener: () => void, filter: { urls: string[]; types: string[] }): void };
    };
}

const URL = "https://www.xvideos.com/";
const AUTH = "session_token_auth";
const SESSION = "session_token";

export function startCookiePersistence(api: CookieApi): void {
    if (api.extension?.inIncognitoContext) return;
    let revision = 0;

    async function persist(expectedRevision: number, storeId: string): Promise<void> {
        const [auth, session] = await Promise.all([
            api.cookies.get({ url: URL, name: AUTH, storeId }),
            api.cookies.get({ url: URL, name: SESSION, storeId }),
        ]);
        if (revision !== expectedRevision || !auth || !session || !auth.session) return;
        if (!auth.httpOnly || !auth.secure || auth.domain !== session.domain || auth.path !== session.path
            || auth.storeId !== storeId || auth.storeId !== session.storeId || !session.expirationDate
            || session.expirationDate <= Date.now() / 1000) return;
        // Match the site's already-persistent session lifetime. Server expiry,
        // revocation and logout still apply; no token is recreated from a backup.
        await api.cookies.set({
            url: URL, name: AUTH, value: auth.value, path: auth.path,
            ...(auth.hostOnly ? {} : { domain: auth.domain }),
            storeId: auth.storeId, secure: auth.secure, httpOnly: auth.httpOnly,
            sameSite: auth.sameSite, expirationDate: session.expirationDate,
        });
    }

    const refresh = (): void => {
        const current = ++revision;
        void api.cookies.getAllCookieStores().then(stores => Promise.all(
            stores.filter(store => !store.incognito).map(store => persist(current, store.id)),
        )).catch(() => console.warn("XVideos cookie persistence is unavailable; check extension website access."));
    };
    api.cookies.onChanged.addListener(change => {
        if (change.cookie.domain.replace(/^\./, "") !== "xvideos.com"
            || ![AUTH, SESSION].includes(change.cookie.name)) return;
        if (change.removed) { revision++; return; }
        refresh();
    });
    api.runtime.onInstalled.addListener(refresh);
    api.runtime.onStartup.addListener(refresh);
    // Safari accepts cookies.onChanged listeners but does not dispatch them.
    // Recheck after site responses so renewed session cookies survive the next
    // browser restart too. Read the current jar; never resurrect removed cookies.
    api.webRequest.onCompleted.addListener(refresh, {
        urls: ["https://xvideos.com/*", "https://www.xvideos.com/*"],
        types: ["main_frame", "sub_frame", "xmlhttprequest"],
    });
    refresh();
}
