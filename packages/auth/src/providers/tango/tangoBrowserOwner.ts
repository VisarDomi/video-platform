import { chromium, type BrowserContext, type Request } from "playwright";
import { mkdir, readFile, writeFile, rename, chmod, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createHash} from "node:crypto";
import { parseJwtPayload } from "../../auth/authUtils.js";
import { extractTokens } from "./tangoLogin.js";
import { withLoginLease } from "../../browser/loginLease.js";
import { rejectedSession } from "./tangoBrowserSession.js";
import { BrowserVerificationRequiredError, type Account, type TokenBag } from "../interfaces.js";

export const BROWSER_PROFILE = "tangoBrowserProfile";
const owners = new Map<string, TangoBrowserOwner>();
type Cookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
const firstParty = (host:string)=>host.replace(/^\./, "")==="tango.me"||host.endsWith(".tango.me");
export function browserRefreshCookie(cookies:Cookies):Cookies[number]|null {
    return cookies.filter(c=>firstParty(c.domain)&&c.name==="Tango-RT"&&Number(parseJwtPayload(c.value)?.exp)*1000>Date.now())
        .sort((a,b)=>Number(parseJwtPayload(b.value)?.iat)-Number(parseJwtPayload(a.value)?.iat))[0]??null;
}

export function browserPair(cookies: Cookies): TokenBag | null {
    const valid=cookies.filter(c=>firstParty(c.domain)&&["Tango-RT","Tango-ST"].includes(c.name)
        && Number(parseJwtPayload(c.value)?.exp)*1000>Date.now());
    for(const rt of valid.filter(c=>c.name==="Tango-RT").sort((a,b)=>Number(parseJwtPayload(b.value)?.iat)-Number(parseJwtPayload(a.value)?.iat))){
        const owner=parseJwtPayload(rt.value);
        if(!owner?.accountId||!owner?.sessionId||owner.guest===true)continue;
        const st=valid.find(c=>c.name==="Tango-ST"&&parseJwtPayload(c.value)?.accountId===owner.accountId&&parseJwtPayload(c.value)?.sessionId===owner.sessionId);
        if(st)return {refreshToken:rt.value,sessionToken:st.value,extras:{}};
    }
    return null;
}

// The real website owns the rotating credential and its entire browser identity:
// cookies, local/session storage, IndexedDB and device state remain in Chromium.
// Native callers only obtain the resulting credentials; they do not rotate RT.
export class TangoBrowserOwner {
    private context?: BrowserContext;
    private opening?: Promise<BrowserContext>;
    private work?: Promise<TokenBag>;
    private timer?: ReturnType<typeof setInterval>;
    private saving: Promise<void> = Promise.resolve();
    private lastSaved = "";
    private readSequence=0;
    private savedSequence=0;
    private latest?:TokenBag;
    private latestCookieIdentity="";
    private events: {path:string;status:number;verificationHeader:boolean}[]=[];
    private eventRevision=0;
    private savedEventRevision=-1;
    private rejected = false;
    private rejectedRefresh?: string;
    private nextSignInAttempt=0;
    private rejectedAccess?:string;
    private renewNotBefore=0;
    private relinquished=false;
    private pendingAuth=new Set<Request>();
    private lastAuthActivity=0;
    private readonly directory: string;
    private readonly journal: string;
    constructor(readonly name: string) {
        if(!/^[a-z0-9-]{1,100}$/.test(name))throw new Error("Invalid Tango profile name");
        this.directory=path.join(os.homedir(),".local/share/video-services/tango-browser-profiles",name);
        this.journal=path.join(this.directory,"owner-session.json");
    }

    private async open(navigate=true): Promise<BrowserContext> {
        if(this.context)return this.context;
        if(this.opening)return this.opening;
        this.opening=(async()=>{
            await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
            const context=await chromium.launchPersistentContext(path.join(this.directory,"chromium"),{
                headless:false,env:{...process.env,DISPLAY:":111",
                    DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS??`unix:path=/run/user/${process.getuid?.()}/bus`,XDG_CURRENT_DESKTOP:process.env.XDG_CURRENT_DESKTOP??"X-Cinnamon"},
                args:[...(this.name.startsWith("pc-")?["--restore-last-session"]:[]),"--disable-gpu","--disable-gpu-compositing","--disable-blink-features=AutomationControlled",
                    "--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding","--autoplay-policy=document-user-activation-required",
                    "--password-store=gnome-libsecret","--disable-features=DbusSecretPortal,SecretPortalKeyProviderUseForEncryption"],
            });
            this.context=context;
            const authRequest=(request:Request)=>{try{const u=new URL(request.url());return firstParty(u.hostname)&&(u.pathname.endsWith('/session/web/refresh')||u.pathname.endsWith('/google-login/auth-code/v1/login'));}catch{return false;}};
            context.on('request',request=>{if(authRequest(request)){this.pendingAuth.add(request);this.lastAuthActivity=Date.now();}});
            const completed=(request:Request)=>{if(this.pendingAuth.delete(request))this.lastAuthActivity=Date.now();};
            context.on('requestfinished',completed);context.on('requestfailed',completed);
            // A clean profile is canonical. The journal repairs a profile rollback
            // after the server rotated RT and before Chromium flushed its database.
            try{
                const saved=JSON.parse(await readFile(this.journal,"utf8")) as {cookies:Cookies};
                const current=browserRefreshCookie(await context.cookies()), backup=browserRefreshCookie(saved.cookies);
                if(backup&&(!current||Number(parseJwtPayload(backup.value)?.iat)>Number(parseJwtPayload(current.value)?.iat)))await context.addCookies(saved.cookies);
            }catch(error:any){if(error.code!=="ENOENT")throw error;}
            context.on("response",response=>{
                let endpoint:string;
                try{const u=new URL(response.url());if(!firstParty(u.hostname)||(!u.pathname.includes("/session")&&!u.pathname.includes("/google-login")))return;endpoint=u.pathname;}catch{return;}
                this.events.push({path:endpoint,status:response.status(),verificationHeader:"x-verification" in response.request().headers()});
                this.events=this.events.slice(-24);this.eventRevision++;
                if(response.status()===401||response.status()===403)void (async()=>{
                    const sent=await response.request().headerValue("cookie");
                    if(!sent?.includes("Tango-RT="))return; // An expired ST is routine renewal, not a revoked login.
                    const body=await response.json();
                    if(rejectedSession(response.status(),body)){
                        const token=sent.split(";").map(x=>x.trim()).find(x=>x.startsWith("Tango-RT="))?.slice(9);
                        const current=(await context.cookies()).filter(c=>c.name==="Tango-RT"&&firstParty(c.domain));
                        if(current.length&&current.every(c=>c.value!==token))return;
                        this.rejected=true;this.rejectedRefresh=token;
                    }
                })().catch(()=>{});
            });
            context.on("close",()=>{if(this.context!==context)return;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.context=undefined;});
            this.watch();
            const page=context.pages().find(p=>p.url().startsWith("https://www.tango.me"))??context.pages()[0]??await context.newPage();
            if(navigate){await page.goto("https://www.tango.me",{waitUntil:"domcontentloaded",timeout:30_000});await page.bringToFront();}
            return context;
        })();
        try{return await this.opening;}finally{this.opening=undefined;}
    }

    private async saveCurrent(): Promise<TokenBag | null> {
        const context=this.context;if(!context||this.relinquished)return null;
        const sequence=++this.readSequence;
        const cookies=(await context.cookies()).filter(c=>firstParty(c.domain));
        if(this.relinquished||context!==this.context)return null;
        const pair=browserPair(cookies);if(!pair)return null;
        if(sequence<this.savedSequence)return this.latest??pair;
        this.savedSequence=sequence;this.latest=pair;
        if(this.rejectedRefresh&&pair.refreshToken!==this.rejectedRefresh){this.rejected=false;this.rejectedRefresh=undefined;}
        pair.extras[BROWSER_PROFILE]=this.name;
        const identity=JSON.stringify(cookies.filter(c=>c.name.startsWith("Tango-")).sort((a,b)=>(a.name+a.domain+a.path).localeCompare(b.name+b.domain+b.path)));
        this.latestCookieIdentity=identity;
        if(identity!==this.lastSaved||this.eventRevision!==this.savedEventRevision){
            const data=JSON.stringify({cookies,at:Date.now()});
            const job=this.saving.catch(()=>{}).then(async()=>{
                if(this.relinquished||this.latestCookieIdentity!==identity)return;
                await writeFile(this.journal+".tmp",data,{mode:0o600});await rename(this.journal+".tmp",this.journal);
                const file=await open(this.journal,"r");try{await file.sync();}finally{await file.close();}
                const rt=parseJwtPayload(pair.refreshToken)!,st=parseJwtPayload(pair.sessionToken!)!;
                const status={at:Date.now(),profile:this.name,account:createHash("sha256").update(rt.accountId).digest("hex").slice(0,16),
                    session:createHash("sha256").update(rt.sessionId).digest("hex").slice(0,16),refreshIssuedAt:rt.iat,accessExpires:st.exp,
                    cookieNames:[...new Set(cookies.filter(c=>c.name.startsWith("Tango-")).map(c=>c.name))],events:this.events};
                const target=path.join(this.directory,"status.json");await writeFile(target+".tmp",JSON.stringify(status),{mode:0o600});await rename(target+".tmp",target);
                this.savedEventRevision=this.eventRevision;
                this.lastSaved=identity;
            });this.saving=job;await job;
        }
        return pair;
    }

    async signIn(account: Account): Promise<TokenBag> {
        const context=await this.open();
        return withLoginLease(account.email,async()=>{
            const kept=await this.saveCurrent();
            if(!this.rejected&&kept&&Number(parseJwtPayload(kept.sessionToken!)?.exp)*1000>Date.now()+90_000)return kept;
            if(Date.now()<this.nextSignInAttempt)throw new Error("Tango's initial sign-in is cooling down; saved credentials are retained");
            this.nextSignInAttempt=Date.now()+120_000;
            const tokens=await extractTokens(account,context);
            if(!tokens)throw new Error("Tango's initial sign-in did not finish");
            this.rejected=false;this.rejectedRefresh=undefined;
            const page=context.pages().find(p=>p.url().startsWith("https://www.tango.me"));
            if(page){await page.bringToFront();await page.mouse.move(0,0);}
            const current=await this.saveCurrent();
            if(!current)throw new Error("Tango did not retain the signed-in session");
            return current;
        });
    }

    rejectAccess(token:string):void {this.rejectedAccess=createHash("sha256").update(token).digest("hex");}
    private accessRejected(pair:TokenBag,hash?:string):boolean{return !!(hash??this.rejectedAccess)&&createHash("sha256").update(pair.sessionToken??"").digest("hex")===(hash??this.rejectedAccess);}

    session(account?: Account, minimumSeconds=90, rejectedAccessHash?:string): Promise<TokenBag> {
        const cached=this.latest;
        if(!this.rejected&&cached&&!this.accessRejected(cached,rejectedAccessHash)&&Number(parseJwtPayload(cached.sessionToken!)?.exp)*1000>Date.now()+minimumSeconds*1000)return Promise.resolve(cached);
        if(this.work)return this.work;
        const task=this.ensure(account,minimumSeconds,rejectedAccessHash);this.work=task;
        void task.finally(()=>{if(this.work===task)this.work=undefined;}).catch(()=>{});
        return task;
    }

    private async ensure(account: Account | undefined, minimumSeconds:number, rejectedAccessHash?:string): Promise<TokenBag> {
        const context=await this.open();
        let current=await this.saveCurrent();
        if(current&&this.accessRejected(current,rejectedAccessHash))this.rejectedAccess=rejectedAccessHash??this.rejectedAccess;
        if(!this.rejected&&current&&!this.accessRejected(current)&&Number(parseJwtPayload(current.sessionToken!)?.exp)*1000>Date.now()+minimumSeconds*1000)return current;
        const heldRT=(await context.cookies()).some(c=>c.name==="Tango-RT"&&firstParty(c.domain)&&Number(parseJwtPayload(c.value)?.exp)*1000>Date.now());
        if(this.rejected||!heldRT){if(account)return this.signIn(account);throw new BrowserVerificationRequiredError();}
        if(Date.now()<this.renewNotBefore)throw new Error("Tango's saved session is waiting for automatic renewal");
        const page=context.pages().find(p=>p.url().startsWith("https://www.tango.me"))??await context.newPage();
        await page.bringToFront();
        // A page restored after hours must let the current site resume its own
        // renewal. Never delete cookies or fabricate a fresh browser identity.
        if(page.url().startsWith("https://www.tango.me"))await page.reload({waitUntil:"domcontentloaded",timeout:30_000});
        else await page.goto("https://www.tango.me",{waitUntil:"domcontentloaded",timeout:30_000});
        const deadline=Date.now()+65_000;
        while(Date.now()<deadline){
            current=await this.saveCurrent();
            if(current&&!this.accessRejected(current)&&Number(parseJwtPayload(current.sessionToken!)?.exp)*1000>Date.now()+minimumSeconds*1000)return current;
            if(this.rejected){if(account)return this.signIn(account);throw new BrowserVerificationRequiredError();}
            await new Promise(resolve=>setTimeout(resolve,250));
        }
        // Still-valid ST can keep playback running until the website's normal
        // rollover. A temporary failure does not turn into another Google login.
        if(current&&!this.accessRejected(current)&&Number(parseJwtPayload(current.sessionToken!)?.exp)*1000>Date.now()+15_000)return current;
        this.renewNotBefore=Date.now()+30_000;
        throw new Error("Tango's saved browser session has not completed automatic renewal yet");
    }

    async cookies(): Promise<Cookies> {return (await (await this.open()).cookies()).filter(c=>firstParty(c.domain)&&c.name.startsWith("Tango-"));}
    async provision(account:Account,requestId:string):Promise<{cookies:unknown[]}>{
        const pending=path.join(this.directory,"handoff.json");
        let previous=false;
        try{const held=JSON.parse(await readFile(pending,"utf8"));if(held.id===requestId)return held.result;previous=true;}catch(error:any){if(error.code!=="ENOENT")throw error;}
        const context=await this.open(false);
        if(previous)await this.clearTransferredState(context);
        this.relinquished=false;this.watch();
        let current=await this.saveCurrent();
        if(!current){await this.session(account,90);current=await this.saveCurrent();}
        if(!current)throw new Error("Tango did not finish initial setup");
        let cookies=await context.cookies();
        if(!cookies.some(c=>c.name==="Tango-DI"&&firstParty(c.domain))){
            const page=context.pages().find(p=>p.url().startsWith("https://www.tango.me"))??context.pages()[0]??await context.newPage();
            await page.goto("https://www.tango.me",{waitUntil:"domcontentloaded",timeout:30_000});
            const end=Date.now()+25_000;
            do{cookies=await context.cookies();if(cookies.some(c=>c.name==="Tango-DI"&&firstParty(c.domain)))break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<end);
        }
        if(!cookies.some(c=>c.name==="Tango-DI"&&firstParty(c.domain)))throw new Error("Tango's device context has not finished initializing");
        const drainDeadline=Date.now()+20_000;
        while(this.pendingAuth.size||Date.now()-this.lastAuthActivity<750){
            if(Date.now()>drainDeadline)throw new Error("Tango setup is still completing its credential transaction");
            await new Promise(r=>setTimeout(r,100));
        }
        if(this.timer)clearInterval(this.timer);this.timer=undefined;
        // Stop the setup browser before ownership moves to the phone. There is
        // no PC renewal process for this session after the one-time handoff.
        for(const page of context.pages())await page.close({runBeforeUnload:false});
        cookies=(await context.cookies()).filter(c=>firstParty(c.domain)&&c.name.startsWith("Tango-"));
        const result={cookies:cookies.map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,expires:c.expires>0?c.expires:undefined}))};
        await writeFile(pending+".tmp",JSON.stringify({id:requestId,result}),{mode:0o600});await rename(pending+".tmp",pending);
        const durable=await open(pending,"r");try{await durable.sync();}finally{await durable.close();}
        await this.clearTransferredState(context);
        await context.close();this.context=undefined;
        return result;
    }
    private async clearTransferredState(context:BrowserContext):Promise<void>{
        this.relinquished=true;
        if(this.timer)clearInterval(this.timer);this.timer=undefined;
        for(const page of context.pages())await page.close({runBeforeUnload:false});
        await this.saving;
        const blank=await context.newPage();const cdp=await context.newCDPSession(blank);
        for(const origin of ["https://www.tango.me","https://tango.me","https://gateway.tango.me"])await cdp.send("Storage.clearDataForOrigin",{origin,storageTypes:"all"});
        await context.clearCookies({domain:/(^|\.)tango\.me$/});
        const {unlink}=await import("node:fs/promises");await unlink(this.journal).catch(error=>{if(error.code!=="ENOENT")throw error;});
        this.latest=undefined;this.lastSaved="";this.latestCookieIdentity="";this.rejected=false;this.rejectedRefresh=undefined;
    }
    private watch():void{
        if(!this.timer&&!this.relinquished){this.timer=setInterval(()=>{void this.saveCurrent().catch(()=>{});},1000);this.timer.unref();}
    }
    async acknowledgeProvision(requestId:string):Promise<void>{
        const pending=path.join(this.directory,"handoff.json");
        try{if(JSON.parse(await readFile(pending,"utf8")).id===requestId){const{unlink}=await import("node:fs/promises");await unlink(pending);}}catch(error:any){if(error.code!=="ENOENT")throw error;}
    }
    async close(): Promise<void> {
        if(this.timer)clearInterval(this.timer);this.timer=undefined;
        await this.saveCurrent();await this.saving;
        await this.context?.close();this.context=undefined;
    }
}

export function browserOwner(name:string):TangoBrowserOwner {
    if(!shutdownInstalled){shutdownInstalled=true;for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{void closeBrowserOwners().finally(()=>process.exit(0));});}
    let owner=owners.get(name);if(!owner){owner=new TangoBrowserOwner(name);owners.set(name,owner);}return owner;
}
let shutdownInstalled=false;
export async function closeBrowserOwners():Promise<void>{await Promise.allSettled([...owners.values()].map(o=>o.close()));}
