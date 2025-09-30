// src/auth/authConstants.ts

/**
 * URLs for the Tango authentication and API gateways.
 */
export const TANGO_URLS = {
    HOME: 'https://tango.me',
    GATEWAY: 'https://gateway.tango.me',
    SESSION_REFRESH: 'https://gateway.tango.me/proxycador/api/session/refresh',
    TOKEN_DATA: 'https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData',
    GOOGLE_LOGIN: 'https://gateway.tango.me/google-login/auth-code/v1/login'
};

/**
 * Names and prefixes for cookies used in authentication.
 */
export const COOKIE_NAMES = {
    // Long-lived refresh token
    TANGO_RT: 'Tango-RT',
    TANGO_RT_PREFIX: 'Tango-RT=',

    // Short-lived session token (1 hour)
    TANGO_ST: 'Tango-ST',
    TANGO_ST_PREFIX: 'Tango-ST=',

    // Short-lived stream access tokens (5 seconds)
    TT: 'tt',
    TT_PREFIX: 'tt=',
    TTU: 'ttu',
    TTU_PREFIX: 'ttu=',
    TTE: 'tte',
    TTE_PREFIX: 'tte=',
};

/**
 * Standard HTTP headers and values.
 */
export const HEADERS = {
    USER_AGENT: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    COOKIE: 'cookie'
};