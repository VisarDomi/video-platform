export interface TokenBag {
    refreshToken: string;
    sessionToken: string | null;
    extras: Record<string, string | null>;
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
    fetchShortTokens(tokenBag: TokenBag): Promise<ShortTokenResult>;
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
