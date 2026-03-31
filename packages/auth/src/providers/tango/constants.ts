export const TANGO_STREAM_TOKEN_TTL_S = 10;
export const TANGO_SESSION_TOKEN_TTL_S = 60 * 60;
export const TANGO_STREAM_TOKEN_REFRESH_MS = (TANGO_STREAM_TOKEN_TTL_S / 2) * 1000;
export const TANGO_SESSION_REFRESH_MS = (TANGO_SESSION_TOKEN_TTL_S / 2) * 1000;

export const TANGO_URLS = {
    HOME: "https://tango.me",
    SESSION_REFRESH: "https://gateway.tango.me/proxycador/api/session/refresh",
    TOKEN_DATA: "https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData",
    GOOGLE_LOGIN: "https://gateway.tango.me/google-login/auth-code/v1/login",
};
export const COOKIE_NAMES = {
    TANGO_RT_PREFIX: "Tango-RT=",

    TANGO_ST_PREFIX: "Tango-ST=",

    TT_PREFIX: "tt=",
    TTU_PREFIX: "ttu=",
    TTE_PREFIX: "tte=",
};
export const HEADERS = {
    USER_AGENT: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    COOKIE: "cookie",
};

export function extractCookie(cookies: string[], prefix: string): string | null {
    for (const cookie of cookies) {
        const trimmed = cookie.trim();
        if (trimmed.startsWith(prefix)) {
            return trimmed.split(";")[0].substring(prefix.length);
        }
    }
    return null;
}
