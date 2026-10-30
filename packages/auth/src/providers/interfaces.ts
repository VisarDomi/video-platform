export interface TokenBag {
    refreshToken: string;
    sessionToken: string | null;
    extras: Record<string, string | null>;
}

export class BrowserVerificationRequiredError extends Error {
    readonly code = "CHALLENGE_REQUIRED";
    constructor() {
        super("Tango requires browser verification before this session can be renewed.");
        this.name = "BrowserVerificationRequiredError";
    }
}

export class BrowserLoginNeedsAttentionError extends Error {
    constructor() {
        super("Google sign-in needs user verification; automatic password retries have stopped.");
        this.name = "BrowserLoginNeedsAttentionError";
    }
}

export interface RefreshResult {
    newSessionToken: string;
    newRefreshToken: string | null;
}

export interface ShortTokenResult {
    extras: Record<string, string | null>;
}

export interface IAuthProvider {
    readonly name: string;
    login(account: Account): Promise<TokenBag>;
    refreshSession(tokenBag: TokenBag): Promise<RefreshResult>;
    // timeoutMs bounds the request, queue wait included.
    fetchShortTokens(tokenBag: TokenBag, timeoutMs: number): Promise<ShortTokenResult>;
    extractUsername(refreshToken: string): string | null;
    serializeTokens(bag: TokenBag): Record<string, any>;
    deserializeTokens(data: Record<string, any>): TokenBag | null;
    readonly intervals: {
        shortTokenRefresh: number;
        sessionRefresh: number;
    };
}

export interface Account {
    email: string;
    password: string;
    provider: string;
}
