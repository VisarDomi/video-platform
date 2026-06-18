import { CONSTANTS } from "../../core/constants";

export class AuthService {
    private defaultInit: RequestInit;

    constructor(defaultInit: RequestInit) {
        this.defaultInit = defaultInit;
    }

    private async refreshTokens(): Promise<boolean> {
        try {
            const tokenResponse = await fetch(CONSTANTS.API.TOKEN_DATA, this.defaultInit);
            if (tokenResponse.status === 200) {
                const tokenResponseBody = await tokenResponse.json();
                const expires = new Date(tokenResponseBody.expireAt * 1000).toUTCString();

                document.cookie = `tt=${tokenResponseBody.token}; expires=${expires}; domain=.tango.me; path=/`;
                document.cookie = `tte=${tokenResponseBody.expireAt}; expires=${expires}; domain=.tango.me; path=/`;
                document.cookie = `ttu=${tokenResponseBody.username}; expires=${expires}; domain=.tango.me; path=/`;
                return true;
            }
        } catch (error) {
            console.error("Failed to refresh tokens:", error);
        }
        return false;
    }

    public async ensureTokens(): Promise<void> {
        const accountId = localStorage.getItem("latest_account_id");
        const sessionId = sessionStorage.getItem("username");

        if (!accountId || !sessionId) {
            document.body?.insertAdjacentHTML("beforeend", `<div style="position:fixed;top:0;left:0;right:0;background:red;color:#fff;font:20px monospace;padding:16px;z-index:99999">[tango] No session. Are you logged into tango.me?</div>`);
            throw new Error("[tango] No session credentials (accountId or sessionId missing from storage).");
        }

        try {
            const response = await new Promise<{ status: number }>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", "https://gateway.tango.me/session-service/public/v2/session/web/refresh");
                xhr.withCredentials = true;
                xhr.setRequestHeader("Content-Type", "application/json");
                xhr.setRequestHeader("Accept", "application/json");
                xhr.onload = () => resolve({ status: xhr.status });
                xhr.onerror = () => reject(new Error("XHR network error"));
                xhr.send(JSON.stringify({ accountId, sessionId }));
            });

            if (response.status !== 200) {
                console.warn(`[tango] Session refresh returned ${response.status}`);
            }
        } catch (error) {
            console.error("[tango] Failed to refresh session:", error);
        }
    }

    public startTokenRefresh(originalSetInterval: typeof window.setInterval) {
        void this.refreshTokens();
        originalSetInterval(() => this.refreshTokens(), 5000);
    }
}
