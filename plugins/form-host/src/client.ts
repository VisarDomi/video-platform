import { readFile } from "node:fs/promises";
import { writeFileDurably } from "sdk";

// The host's cookies (consent, the rotating session id, the remember-me token), kept in
// the destination's state folder so a session survives restarts. Written durably on every
// change: a power cut leaves the previous or the new jar, never a torn file.
interface Jar {
    cookies: Record<string, string>;
    passwordLoginAt: string | null;
}

export interface HostReply {
    readonly status: number;
    readonly location: string | null;
    readonly text: string;
    readonly headers: Headers;
}

export class FormHostClient {
    private jar: Jar = { cookies: {}, passwordLoginAt: null };
    private loaded = false;

    constructor(
        readonly baseUrl: string,
        private readonly jarFile: string,
        private readonly signal: AbortSignal,
    ) {}

    get passwordLoginAt(): string | null { return this.jar.passwordLoginAt; }
    has(name: string): boolean { return Boolean(this.jar.cookies[name]); }
    cookie(name: string): string | null { return this.jar.cookies[name] ?? null; }

    async load(): Promise<void> {
        if (this.loaded) return;
        try {
            const saved = JSON.parse(await readFile(this.jarFile, "utf8")) as Partial<Jar>;
            this.jar = { cookies: { ...(saved.cookies ?? {}) }, passwordLoginAt: saved.passwordLoginAt ?? null };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.loaded = true;
    }

    async notePasswordLogin(at: Date): Promise<void> {
        this.jar.passwordLoginAt = at.toISOString();
        await this.save();
    }

    // One request, redirects not followed (a redirect is an answer: often "signed out").
    async request(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<HostReply> {
        await this.load();
        const cookie = Object.entries(this.jar.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
        const response = await fetch(new URL(path, this.baseUrl), {
            method: init.method ?? "GET",
            body: init.body,
            headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
            redirect: "manual",
            signal: this.signal,
        });
        const text = await response.text();
        await this.absorb(response.headers.getSetCookie());
        return { status: response.status, location: response.headers.get("location"), text, headers: response.headers };
    }

    private async absorb(setCookies: string[]): Promise<void> {
        let changed = false;
        for (const line of setCookies) {
            const [pair, ...attributes] = line.split(";").map((part) => part.trim());
            const equals = pair.indexOf("=");
            if (equals < 1) continue;
            const name = pair.slice(0, equals);
            const value = decodeURIComponent(pair.slice(equals + 1));
            const expired = attributes.some((attribute) => /^max-age=0$/i.test(attribute)) || value === "";
            if (expired) {
                if (name in this.jar.cookies) { delete this.jar.cookies[name]; changed = true; }
            } else if (this.jar.cookies[name] !== value) {
                this.jar.cookies[name] = value;
                changed = true;
            }
        }
        if (changed) await this.save();
    }

    private async save(): Promise<void> {
        await writeFileDurably(this.jarFile, JSON.stringify(this.jar));
    }
}
