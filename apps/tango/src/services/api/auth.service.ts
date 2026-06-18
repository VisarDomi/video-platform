import { CONSTANTS } from "../../core/constants";
import { xhrFetch } from "../../core/xhr-fetch";

export class AuthService {
    private async refreshTokens(): Promise<void> {
        const tokenResponse = await xhrFetch(CONSTANTS.API.TOKEN_DATA);
        const tokenResponseBody = await tokenResponse.json();
        const expires = new Date(tokenResponseBody.expireAt * 1000).toUTCString();
        document.cookie = `tt=${tokenResponseBody.token}; expires=${expires}; domain=.tango.me; path=/`;
        document.cookie = `tte=${tokenResponseBody.expireAt}; expires=${expires}; domain=.tango.me; path=/`;
        document.cookie = `ttu=${tokenResponseBody.username}; expires=${expires}; domain=.tango.me; path=/`;
    }

    public async ensureTokens(): Promise<void> {
        const accountId = localStorage.getItem("latest_account_id");
        const sessionId = sessionStorage.getItem("username");

        if (!accountId || !sessionId) {
            throw new Error("Not logged in");
        }

        const response = await xhrFetch("https://gateway.tango.me/session-service/public/v2/session/web/refresh", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, sessionId }),
        });

        if (response.status !== 200) {
            throw new Error(`Session refresh returned ${response.status}`);
        }
    }

    public startTokenRefresh(originalSetInterval: typeof window.setInterval) {
        void this.refreshTokens();
        originalSetInterval(() => this.refreshTokens(), 5000);
    }
}
