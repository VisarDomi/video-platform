import { type BrowserContext } from "playwright";
import { parseJwtPayload } from "../../auth/authUtils.js";
import { type TokenBag } from "../interfaces.js";

export const BROWSER_STATE = "tangoBrowserState";
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
const firstParty = (host: string) => host.replace(/^\./, "") === "tango.me" || host.endsWith(".tango.me");
const claims = (token: string) => parseJwtPayload(token);

export function rejectedSession(status: number, body: any): boolean {
    return (status === 401 || status === 403) && ["BAD_USERNAME", "SESSION_COMPROMISED", "SESSION_NOT_FOUND", "SESSION_EXPIRED", "INVALID_SESSION", "INVALID_TOKEN", "TOKEN_EXPIRED"].includes(body?.errorCode);
}

export function tangoState(state: State): State {
    return { cookies: state.cookies.filter(c => firstParty(c.domain)),
        origins: state.origins.filter(o => { try { return firstParty(new URL(o.origin).hostname); } catch { return false; } }) };
}

export async function captureBrowserSession(context: BrowserContext, fallback?: TokenBag): Promise<TokenBag> {
    let state = tangoState(await context.storageState());
    const seed = fallback?.refreshToken ?? state.cookies.find(c=>c.name==="Tango-RT")?.value;
    const owner = seed ? claims(seed) : null;
    const page = typeof context.pages === "function" ? context.pages().find(p=>{try{return firstParty(new URL(p.url()).hostname);}catch{return false;}}) : null;
    if (page && owner?.accountId && owner?.sessionId) {
        await page.waitForFunction(ids => (localStorage.getItem("persist:production:user") ?? "").includes(ids.accountId)
            && (localStorage.getItem("persist:production:connectionManager") ?? "").includes(ids.sessionId),
            {accountId:String(owner.accountId),sessionId:String(owner.sessionId)}, {timeout:15_000,polling:100});
        state = tangoState(await context.storageState());
    }
    const valid = state.cookies.filter(c => ["Tango-RT","Tango-ST"].includes(c.name) && Number(claims(c.value)?.exp) * 1000 > Date.now());
    const refreshes = valid.filter(c => c.name === "Tango-RT").sort((a, b) => Number(claims(b.value)?.iat) - Number(claims(a.value)?.iat));
    for (const rt of refreshes) {
        const owner = claims(rt.value);
        const st = valid.find(c => c.name === "Tango-ST" && claims(c.value)?.accountId === owner?.accountId && claims(c.value)?.sessionId === owner?.sessionId);
        if (st) return { refreshToken: rt.value, sessionToken: st.value,
            extras: { ...fallback?.extras, [BROWSER_STATE]: JSON.stringify(state) } };
    }
    throw new Error("Tango browser did not retain a coherent current session.");
}
