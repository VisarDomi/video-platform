import { CONSTANTS } from "../../core/constants";

export class AuthService {
    private defaultInit: RequestInit;

    constructor(defaultInit: RequestInit) {
        this.defaultInit = defaultInit;
    }

    public startTokenRefresh(originalSetInterval: typeof window.setInterval) {
        const setTokens = async () => {
            try {
                const tokenResponse = await fetch(CONSTANTS.API.TOKEN_DATA, this.defaultInit);
                if (tokenResponse.status === 200) {
                    const tokenResponseBody = await tokenResponse.json();
                    const expires = new Date(tokenResponseBody.expireAt * 1000).toUTCString();

                    document.cookie = `tt=${tokenResponseBody.token}; expires=${expires}; domain=.tango.me; path=/`;
                    document.cookie = `tte=${tokenResponseBody.expireAt}; expires=${expires}; domain=.tango.me; path=/`;
                    document.cookie = `ttu=${tokenResponseBody.username}; expires=${expires}; domain=.tango.me; path=/`;
                }
            } catch (error) {
                console.error("Failed to refresh tokens:", error);
            }
        };

        setTokens();
        originalSetInterval(setTokens, 5000);
    }
}
